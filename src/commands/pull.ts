import { parseArgs } from "../args.ts";
import type { Context } from "../context.ts";
import { formatDuration, parseDuration } from "../duration.ts";
import { fail, SlopenvError } from "../errors.ts";
import { resolveRuleDir, tilde } from "../paths.ts";
import { maskSecret } from "../prompt.ts";
import { loadRules, ruleKey, updateRules, upsertRule, type Rule } from "../rules.ts";
import { hookInactiveNotice, hookIsActive } from "../state.ts";
import { ENGINES, engineById, engineForRef, resolveRef, type VaultEngine } from "../vault/index.ts";

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

/**
 * Fetch one rule's value and cache it in the keychain. Deliberately does not touch
 * rules.json: `--all` writes once at the end instead of once per secret, because
 * every write changes the file's fingerprint and makes every live shell re-resolve.
 */
function fetchAndCache(ctx: Context, rule: Rule): { value: string; changed: boolean } {
  const engine = engineById(rule.engine as string);
  if (!engine) {
    fail(
      `${rule.name} (${tilde(rule.dir)}) uses engine ${JSON.stringify(rule.engine)}, which this slopenv does not know.\n` +
        `  Either the rules file was written by a newer build, or it was hand-edited.\n` +
        `  Known engines: ${knownEngines()}`,
    );
  }

  const value = resolveRef(engine, rule.ref as string, { env: ctx.env });

  // Read before writing so that "unchanged" is the truth rather than an assumption.
  // A missing cache entry reads as a change, which is exactly right.
  let previous: string | null = null;
  try {
    previous = ctx.secretStore().get(rule.dir, rule.name);
  } catch {
    previous = null;
  }

  if (previous !== value) ctx.secretStore().set(rule.dir, rule.name, value);
  return { value, changed: previous !== value };
}

/** Write the rules, stamping each pulled rule with when it was pulled. */
function record(ctx: Context, rules: readonly Rule[], now: Date): void {
  updateRules(ctx.rulesPath, (file) => {
    let next = file;
    for (const rule of rules) next = upsertRule(next, { ...rule, fetched: now.toISOString() }).file;
    return next;
  });
}

export function cmdPull(argv: readonly string[], ctx: Context): number {
  const args = parseArgs(argv, {
    value: ["ref", "dir", "alias", "engine", "ttl"],
    boolean: ["all"],
  });
  const usage =
    `usage: slopenv pull NAME --ref "op://Vault/Item/field" [DIR] [--alias TEXT] [--ttl 30d]\n` +
    `       slopenv pull NAME [DIR]      re-fetch a reference you already have\n` +
    `       slopenv pull --all           re-fetch every one of them`;

  const now = new Date();

  if (args.flags.has("all")) {
    if (args.positional.length > 0 || args.values.ref !== undefined) fail(usage);
    return pullAll(ctx, now);
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
  // Absent flags keep what the rule already had, so re-pulling is never a way to
  // quietly lose an alias or a refresh window. `--alias ""` still clears one.
  const alias = args.values.alias !== undefined ? args.values.alias || undefined : existing?.alias;
  if (alias) rule.alias = alias;
  const ttl = args.values.ttl !== undefined ? parseDuration(args.values.ttl) : existing?.ttl;
  if (ttl !== undefined) rule.ttl = ttl;

  const { value, changed } = fetchAndCache(ctx, rule);

  try {
    record(ctx, [rule], now);
  } catch (err) {
    ctx.err(
      `slopenv: ${name} was cached in the keychain but the rules file was not updated — ` +
        `nothing will use it until that is fixed.\n`,
    );
    throw err;
  }

  if (existing?.source === "link") {
    ctx.err(`slopenv: this directory used to link to ${existing.target}; it now has a reference of its own\n`);
  }

  ctx.out(`${name} = ${maskSecret(value)}  [vault]  ${dir}${rule.alias ? `  ${rule.alias}` : ""}\n`);
  ctx.out(`  ${changed ? "pulled from" : "unchanged, from"} ${ref}\n`);
  if (rule.ttl !== undefined) ctx.out(`  refresh window ${formatDuration(rule.ttl)}\n`);
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
function pullAll(ctx: Context, now: Date): number {
  const rules = loadRules(ctx.rulesPath)
    .rules.filter((r) => r.source === "vault")
    .sort((a, b) => a.dir.localeCompare(b.dir) || a.name.localeCompare(b.name));

  if (rules.length === 0) {
    ctx.out(`no vault references yet\n`);
    ctx.out(`add one with:  slopenv pull MY_TOKEN --ref "op://Vault/Item/field"\n`);
    return 0;
  }

  const pulled: Rule[] = [];
  const failed: Rule[] = [];

  for (const rule of rules) {
    try {
      const { value, changed } = fetchAndCache(ctx, rule);
      pulled.push(rule);
      ctx.out(`  ${changed ? "pulled   " : "unchanged"}  ${rule.name} (${tilde(rule.dir)})  ${maskSecret(value)}\n`);
    } catch (err) {
      failed.push(rule);
      const message = err instanceof SlopenvError ? err.message : ((err as Error).message ?? String(err));
      ctx.err(`slopenv: ${rule.name} (${tilde(rule.dir)}) — ${message}\n`);
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
