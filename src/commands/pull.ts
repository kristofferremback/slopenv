import { parseArgs } from "../args.ts";
import type { Context } from "../context.ts";
import { formatDuration, parseDuration } from "../duration.ts";
import { fail, SlopenvError } from "../errors.ts";
import { resolveRuleDir, tilde } from "../paths.ts";
import { maskSecret } from "../prompt.ts";
import { loadRules, ruleKey, updateRules, upsertRule, usesKeychain, type Rule } from "../rules.ts";
import { describeSuspicion, detectSecretish } from "../secretish.ts";
import { confirm, isInteractive } from "../prompt.ts";
import { hookInactiveNotice, hookIsActive } from "../state.ts";
import { ENGINES, engineById, engineForRef, resolveMany, resolveRef, type VaultEngine } from "../vault/index.ts";

/**
 * `slopenv pull` — fetch a value from an external secret manager and cache it in
 * the keychain, so that every `cd` afterwards costs exactly what a keychain rule
 * costs and never touches the network.
 *
 * The rule stores the vault's *reference*, not its value. That is what makes a
 * rules file describe where your secrets live rather than contain them, and what
 * makes a new machine one command rather than an afternoon of copy-paste.
 */

function knownEngines(): string {
  return ENGINES.map((e) => `${e.id} (${e.label})`).join(", ");
}

function resolveEngine(ref: string, requested: string | undefined): VaultEngine {
  const fromRef = engineForRef(ref);
  if (requested === undefined) return fromRef;

  const named = engineById(requested);
  if (!named) fail(`unknown engine ${JSON.stringify(requested)} — slopenv knows ${knownEngines()}`);
  if (named.id !== fromRef.id) {
    fail(`--engine ${named.id} does not match a ${fromRef.scheme}:// reference, which is ${fromRef.label}`);
  }
  return named;
}

function engineFor(rule: Rule): VaultEngine {
  const engine = engineById(rule.engine as string);
  if (!engine) {
    fail(
      `${rule.name} (${tilde(rule.dir)}) uses engine ${JSON.stringify(rule.engine)}, which this slopenv does not know.\n` +
        `  Either the rules file was written by a newer build, or it was hand-edited.\n` +
        `  Known engines: ${knownEngines()}`,
    );
  }
  return engine;
}

/**
 * Put a resolved value where its rule says it goes.
 *
 * The keychain write happens here; the rules.json write does not, because `--all`
 * writes once at the end rather than once per secret — every write changes the
 * file's fingerprint and makes every live shell re-resolve.
 *
 * A rule stored in the file therefore has nothing to do here except report what
 * changed; `record` carries its value to disk.
 */
async function cache(
  ctx: Context,
  rule: Rule,
  previousRule: Rule | undefined,
  value: string,
): Promise<{ changed: boolean }> {
  // A rule that has stopped keeping its value in the keychain must not leave the
  // old copy behind — that is how a keychain fills up with secrets whose rules
  // are long gone.
  if (usesKeychain(previousRule) && !usesKeychain(rule)) {
    try {
      await ctx.secretStore().remove(rule.dir, rule.name);
    } catch (err) {
      ctx.err(`slopenv: could not delete the secret-store entry for ${rule.name}: ${(err as Error).message}\n`);
    }
  }

  if (!usesKeychain(rule)) return { changed: previousRule?.value !== value };

  // Read before writing so that "unchanged" is the truth rather than an assumption.
  // A missing entry reads as a change, which is exactly right.
  let previous: string | null = null;
  try {
    previous = await ctx.secretStore().get(rule.dir, rule.name);
  } catch {
    previous = null;
  }

  if (previous !== value) await ctx.secretStore().set(rule.dir, rule.name, value);
  return { changed: previous !== value };
}

/**
 * Putting a value in rules.json is putting it on disk in the clear. Anything that
 * looks like a credential has to be confirmed first — the same guard `set` uses,
 * and for the same reason: this is a mistake you would not notice until it
 * mattered. Non-interactive callers get a refusal rather than a hang.
 */
function confirmPlaintext(ctx: Context, rule: Rule, value: string, assumeYes: boolean): void {
  if (assumeYes) return;
  const suspicion = detectSecretish(rule.name, value);
  if (!suspicion) return;

  ctx.err(`slopenv: ${describeSuspicion(rule.name, suspicion)}.\n`);
  ctx.err(`  --plain writes it to ${ctx.rulesPath} in plain text.\n`);
  ctx.err(`  Without --plain it goes to the OS secret store, and \`list\` shows only the last four characters.\n`);

  if (!isInteractive()) {
    fail(`refusing to write what looks like a credential to the rules file. Pass --yes to override, or drop --plain.`);
  }
  if (!confirm("  Write it to the rules file anyway? [y/N] ")) {
    fail("aborted — nothing was written");
  }
}

/** Write the rules, stamping each pulled rule with when it was pulled. */
function record(ctx: Context, rules: readonly Rule[], now: Date): void {
  updateRules(ctx.rulesPath, (file) => {
    let next = file;
    for (const rule of rules) next = upsertRule(next, { ...rule, fetched: now.toISOString() }).file;
    return next;
  });
}

export async function cmdPull(argv: readonly string[], ctx: Context): Promise<number> {
  const args = parseArgs(argv, {
    value: ["ref", "dir", "alias", "engine", "ttl"],
    boolean: ["all", "plain", "secret", "yes", "force"],
    short: { y: "yes", f: "force" },
  });
  const usage =
    `usage: slopenv pull NAME --ref "op://Vault/Item/field" [DIR] [--alias TEXT] [--ttl 30d]\n` +
    `       slopenv pull NAME [DIR]      re-fetch a reference you already have\n` +
    `       slopenv pull --all           re-fetch every one of them\n` +
    `\nBy default the value goes to the OS secret store, because it came out of a secret\n` +
    `manager. --plain keeps it in the rules file instead, in the clear, for the\n` +
    `things in your vault that are not secrets. --secret moves one back.`;

  const now = new Date();

  if (args.flags.has("plain") && args.flags.has("secret")) {
    fail("--plain and --secret are opposites; pass one or neither");
  }

  if (args.flags.has("all")) {
    if (args.positional.length > 0 || args.values.ref !== undefined) fail(usage);
    // Where each value lives is a property of its own rule, and re-fetching is not
    // the moment to change twenty of them at once.
    if (args.flags.has("plain") || args.flags.has("secret")) {
      fail("--plain and --secret apply to one reference at a time, not to --all");
    }
    return await pullAll(ctx, now);
  }

  const name = args.positional[0];
  if (!name) fail(usage);
  if (args.positional.length > 2) fail(usage);

  const dir = resolveRuleDir(args.values.dir ?? args.positional[1] ?? ".", ctx.cwd);
  const file = loadRules(ctx.rulesPath);
  const existing = file.rules.find((r) => ruleKey(r.dir, r.name) === ruleKey(dir, name));

  const ref = args.values.ref ?? existing?.ref;
  if (ref === undefined) {
    fail(
      `no secret reference for ${name} in ${tilde(dir)}.\n` +
        (existing ? `  It is a ${existing.source} rule today. To pull it from a vault instead:\n` : `  Give it one:\n`) +
        `      slopenv pull ${name} --ref "op://Vault/Item/field" ${dir}\n` +
        `  In 1Password, the item's ⌄ menu has "Copy Secret Reference".`,
    );
  }

  const engine = resolveEngine(ref, args.values.engine);

  const rule: Rule = { dir, name, source: "vault", ref, engine: engine.id };
  // Absent flags keep whatever the rule already decided; a new rule defaults to
  // the keychain, because the value is coming out of a secret manager.
  const inFile = args.flags.has("plain") || (!args.flags.has("secret") && existing?.store === "file");
  if (inFile) rule.store = "file";
  // Absent flags keep what the rule already had, so re-pulling is never a way to
  // quietly lose an alias or a refresh window. `--alias ""` still clears one.
  const alias = args.values.alias !== undefined ? args.values.alias || undefined : existing?.alias;
  if (alias) rule.alias = alias;
  const ttl = args.values.ttl !== undefined ? parseDuration(args.values.ttl) : existing?.ttl;
  if (ttl !== undefined) rule.ttl = ttl;

  const value = await resolveRef(engineFor(rule), ref, { env: ctx.env });
  if (inFile) {
    confirmPlaintext(ctx, rule, value, args.flags.has("yes") || args.flags.has("force"));
    rule.value = value;
  }
  const { changed } = await cache(ctx, rule, existing, value);

  try {
    record(ctx, [rule], now);
  } catch (err) {
    ctx.err(
      `slopenv: ${name} was cached in the secret store but the rules file was not updated — ` +
        `nothing will use it until that is fixed.\n`,
    );
    throw err;
  }

  if (existing?.source === "link") {
    ctx.err(`slopenv: this directory used to link to ${existing.target}; it now has a reference of its own\n`);
  }

  // Shown in full when it is stored in the open anyway; masking it there would
  // only pretend to a secrecy the file does not have.
  ctx.out(`${name} = ${inFile ? value : maskSecret(value)}  [vault]  ${dir}${rule.alias ? `  ${rule.alias}` : ""}\n`);
  ctx.out(`  ${changed ? "pulled from" : "unchanged, from"} ${ref}\n`);
  if (rule.ttl !== undefined) ctx.out(`  refresh window ${formatDuration(rule.ttl)}\n`);
  if (inFile) ctx.out(`  kept in ${ctx.rulesPath}, in the clear\n`);
  if (!hookIsActive(ctx.env)) ctx.err(hookInactiveNotice());
  return 0;
}

/**
 * Re-fetch everything. The point of this one is a new machine: a rules file plus
 * `slopenv pull --all` reconstitutes a keychain from nothing.
 *
 * One failure does not stop the rest — finishing is the whole value of the command
 * — but the exit code is non-zero if anything failed, so a script cannot mistake a
 * partial run for a clean one.
 */
async function pullAll(ctx: Context, now: Date): Promise<number> {
  const rules = loadRules(ctx.rulesPath)
    .rules.filter((r) => r.source === "vault")
    .sort((a, b) => a.dir.localeCompare(b.dir) || a.name.localeCompare(b.name));

  if (rules.length === 0) {
    ctx.out(`no vault references yet\n`);
    ctx.out(`add one with:  slopenv pull MY_TOKEN --ref "op://Vault/Item/field"\n`);
    return 0;
  }

  // All the references for one engine go out together, so the waiting overlaps
  // rather than stacking. Sequentially this is ~1.2s each; four at a time it is
  // roughly that once. Grouped by engine because the batching is the engine's
  // business, and a run can involve more than one.
  const byEngine = new Map<string, Rule[]>();
  for (const rule of rules) byEngine.set(rule.engine as string, [...(byEngine.get(rule.engine as string) ?? []), rule]);

  const values = new Map<Rule, { value?: string; error?: unknown }>();
  for (const group of byEngine.values()) {
    const resolved = await resolveMany(
      engineFor(group[0] as Rule),
      group.map((r) => r.ref as string),
      { env: ctx.env },
    );
    group.forEach((rule, index) => values.set(rule, resolved[index] ?? { error: new SlopenvError("no result") }));
  }

  const pulled: Rule[] = [];
  const failed: Rule[] = [];

  // Reported in the order the rules are listed, not the order they came back, so
  // the output is the same however the resolving happened to interleave.
  for (const rule of rules) {
    const result = values.get(rule);
    if (result?.value === undefined) {
      failed.push(rule);
      const err = result?.error;
      const message = err instanceof SlopenvError ? err.message : ((err as Error)?.message ?? String(err));
      ctx.err(`slopenv: ${rule.name} (${tilde(rule.dir)}) — ${message}\n`);
      continue;
    }
    try {
      const next: Rule = rule.store === "file" ? { ...rule, value: result.value } : rule;
      const { changed } = await cache(ctx, next, rule, result.value);
      pulled.push(next);
      const shown = rule.store === "file" ? result.value : maskSecret(result.value);
      ctx.out(`  ${changed ? "pulled   " : "unchanged"}  ${rule.name} (${tilde(rule.dir)})  ${shown}\n`);
    } catch (err) {
      failed.push(rule);
      ctx.err(`slopenv: ${rule.name} (${tilde(rule.dir)}) — ${(err as Error).message}\n`);
    }
  }

  // Only the ones that actually came back get a fresh timestamp; a failed pull
  // must not make a stale value look newly fetched.
  if (pulled.length > 0) record(ctx, pulled, now);

  ctx.out(`\n${pulled.length} of ${rules.length} pulled\n`);
  if (failed.length > 0) {
    ctx.out(`still to do:\n`);
    for (const rule of failed) ctx.out(`  slopenv pull ${rule.name} ${rule.dir}\n`);
    return 1;
  }
  return 0;
}
