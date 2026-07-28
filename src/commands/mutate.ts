import { parseArgs } from "../args.ts";
import type { Context } from "../context.ts";
import { fail } from "../errors.ts";
import { dirCovers, resolveRules } from "../match.ts";
import { isDirectory, resolveRuleDir } from "../paths.ts";
import { describeSuspicion, detectSecretish } from "../secretish.ts";
import { confirm, isInteractive, maskSecret, readValue } from "../prompt.ts";
import {
  assertValidName,
  effectiveRule,
  linksTo,
  loadRules,
  removeRule,
  RISKY_NAMES,
  ruleKey,
  usesKeychain,
  updateRules,
  upsertRule,
  type Rule,
  type RulesFile,
} from "../rules.ts";
import { hookInactiveNotice, hookIsActive } from "../state.ts";

const MUTATE_SPEC = {
  value: ["dir", "value", "alias"],
  boolean: ["yes", "force", "plain", "secret"],
  short: { y: "yes", f: "force" },
} as const;

interface Resolved {
  name: string;
  dir: string;
  value: string | undefined;
  alias: string | undefined;
  aliasGiven: boolean;
  /** `--yes` / `-y` / `--force` / `-f`: skip the plain-text confirmation. */
  assumeYes: boolean;
  /** `--secret`: keep the value in the keychain rather than in the rules file. */
  secret: boolean;
}

/**
 * Was this argument *meant* as a path? A bare word like `Remback` almost certainly
 * was not; anything with a slash almost certainly was, and deserves a plain "that
 * directory does not exist" rather than a lecture about quoting.
 */
function looksLikePath(arg: string): boolean {
  return arg.includes("/") || arg === "." || arg === ".." || arg.startsWith("~");
}

/**
 * A value with spaces that was not quoted arrives as several arguments, and the
 * stray words land where a directory is expected. Say that, rather than reporting
 * the symptom ("no such directory: Remback") and leaving the cause to be guessed.
 *
 * This is only ever a diagnostic: quoting is the shell's business, and the quotes
 * are long gone by the time slopenv sees anything.
 */
function unquotedValueHint(command: string, name: string, value: string, strays: readonly string[]): never {
  const joined = [value, ...strays].join(" ");
  fail(
    `${strays.map((s) => JSON.stringify(s)).join(", ")} is not a directory.\n` +
      `  If the value has spaces in it, quote it. Either way works:\n` +
      `      slopenv ${command} "${name}=${joined}"\n` +
      `      slopenv ${command} ${name}="${joined}"\n` +
      `  Or pass it separately:  slopenv ${command} ${name} --value "${joined}"`,
  );
}

/**
 * Argument grammar:
 *
 *   slopenv set NAME=VALUE [DIR]     value inline
 *   slopenv set NAME [DIR]           prompt for the value
 *   slopenv set NAME VALUE DIR       the three-positional form, still accepted
 *
 * The `=` is what removes the ambiguity: with a bare NAME, a second positional is
 * always a directory, never a value. `--value` and `--dir` remain available for
 * anything that would otherwise be misread.
 */
function resolveMutateArgs(argv: readonly string[], ctx: Context, usage: string, command: string): Resolved {
  const args = parseArgs(argv, MUTATE_SPEC);
  const positional = args.positional;

  // The quoting hint suggests a command line, so it has to be the one you typed —
  // dropping `--secret` from the suggestion would send the value to the wrong place.
  if (args.flags.has("secret")) command = `${command} --secret`;

  const head = positional[0];
  if (!head) fail(usage);

  let name: string;
  let value: string | undefined;
  let dir: string | undefined;

  const eq = head.indexOf("=");
  if (eq > 0) {
    name = head.slice(0, eq);
    value = head.slice(eq + 1);
    const rest = positional.slice(1);
    // One trailing positional is a directory — but only if it really is one. If it
    // is not, the likeliest explanation by far is an unquoted value with a space.
    if (rest.length >= 1 && !isDirectory(rest[0] as string, ctx.cwd) && !looksLikePath(rest[0] as string)) {
      unquotedValueHint(command, name, value, rest);
    }
    if (rest.length > 1) fail(usage);
    dir = rest[0];
  } else {
    name = head;
    if (positional.length > 3) fail(usage);
    if (positional.length === 3) {
      value = positional[1];
      dir = positional[2];
      if (!isDirectory(dir as string, ctx.cwd) && !looksLikePath(dir as string)) {
        unquotedValueHint(command, name, value as string, [dir as string]);
      }
    } else {
      dir = positional[1];
    }
  }

  assertValidName(name);

  if (args.values.value !== undefined) value = args.values.value;
  if (args.values.dir !== undefined) dir = args.values.dir;

  if (args.flags.has("plain") && args.flags.has("secret")) {
    fail("--plain and --secret are opposites; pass one or neither");
  }

  return {
    name,
    dir: resolveRuleDir(dir ?? ".", ctx.cwd),
    value,
    alias: args.values.alias,
    aliasGiven: args.values.alias !== undefined,
    assumeYes: args.flags.has("yes") || args.flags.has("force"),
    secret: args.flags.has("secret"),
  };
}

/**
 * Storing a credential in `rules.json` is a mistake you would not notice until it
 * mattered, so anything that looks like one has to be confirmed. Non-interactive
 * callers get a refusal rather than a hang — silence is not consent.
 */
function confirmPlaintext(ctx: Context, resolved: Resolved, value: string): void {
  if (resolved.assumeYes) return;

  const suspicion = detectSecretish(resolved.name, value);
  if (!suspicion) return;

  ctx.err(`slopenv: ${describeSuspicion(resolved.name, suspicion)}.\n`);
  ctx.err(`  \`set\` writes it to ${ctx.rulesPath} in plain text.\n`);
  ctx.err(`  To put it in the keychain instead:  slopenv set --secret ${resolved.name} ${resolved.dir}\n`);

  if (!isInteractive()) {
    fail(`refusing to store what looks like a credential in plain text. Pass --yes to override, or use \`set --secret\`.`);
  }
  if (!confirm("  Store it in plain text anyway? [y/N] ")) {
    fail("aborted — nothing was written");
  }
}

/** Absent flag keeps whatever the rule already had; `--alias ""` clears it. */
function nextAlias(resolved: Resolved, existing: Rule | undefined): string | undefined {
  if (!resolved.aliasGiven) return existing?.alias;
  return resolved.alias === "" ? undefined : resolved.alias;
}

function findRule(file: RulesFile, dir: string, name: string): Rule | undefined {
  return file.rules.find((r) => ruleKey(r.dir, r.name) === ruleKey(dir, name));
}

/**
 * Giving a directory its own value silently detaches it from the one it borrowed.
 * That is a reasonable thing to want, but not a reasonable thing to discover later.
 */
function warnIfBrokeLink(ctx: Context, replaced: Rule | undefined): void {
  if (replaced?.source === "link") {
    ctx.err(`slopenv: this directory used to link to ${replaced.target}; it now has its own value\n`);
  }
  if (replaced?.source === "vault") {
    ctx.err(`slopenv: this directory used to pull ${replaced.ref} from ${replaced.engine}; it no longer does\n`);
  }
}



function warnIfRisky(ctx: Context, name: string): void {
  if (RISKY_NAMES.has(name)) {
    ctx.err(
      `slopenv: heads up — ${name} is a variable your shell depends on; slopenv will replace it inside this rule's directories\n`,
    );
  }
}

function describe(rule: Rule, shown: string): string {
  const alias = rule.alias ? `  ${rule.alias}` : "";
  return `${rule.name} = ${shown}  [${rule.source}]  ${rule.dir}${alias}`;
}

/**
 * When prompting to replace something, say what is there now. For a secret that
 * is the masked form — enough to know which token you are about to overwrite,
 * not enough to be worth having on screen.
 */
function promptFor(ctx: Context, resolved: Resolved): string {
  const suffix = currentValue(ctx, resolved);
  return `Value for ${resolved.name}${suffix === undefined ? "" : ` [currently ${suffix}]`}: `;
}

function currentValue(ctx: Context, resolved: Resolved): string | undefined {
  let existing: Rule | undefined;
  let rules: readonly Rule[] = [];
  try {
    const file = loadRules(ctx.rulesPath);
    rules = file.rules;
    existing = findRule(file, resolved.dir, resolved.name);
  } catch {
    return undefined; // A broken rules file is not worth failing a prompt over.
  }
  if (!existing) return undefined;

  const holder = effectiveRule(rules, existing);
  if (!holder) return undefined;
  if (holder.source === "plain") return holder.value;

  try {
    const stored = ctx.secretStore().get(holder.dir, resolved.name);
    return stored === null ? undefined : maskSecret(stored);
  } catch {
    return undefined;
  }
}

const SET_USAGE = "usage: slopenv set NAME[=VALUE] [DIR] [--secret] [--alias TEXT]";

/**
 * `set` writes to the rules file; `set --secret` writes to the keychain.
 *
 * Plain is the default because that is what this command usually carries — a port,
 * an environment name, a path — and because a default you override on most
 * invocations is not a safe default, it is a reflex. What makes it safe instead is
 * `confirmPlaintext`: anything that looks like a credential has to be confirmed,
 * so the dangerous case is caught by detection rather than by making every
 * ordinary variable pay for it.
 */
export function cmdSet(argv: readonly string[], ctx: Context): number {
  const resolved = resolveMutateArgs(argv, ctx, SET_USAGE, "set");
  return resolved.secret ? setSecret(ctx, resolved) : setPlain(ctx, resolved);
}

function setSecret(ctx: Context, resolved: Resolved): number {
  warnIfRisky(ctx, resolved.name);

  const value = resolved.value ?? readValue(promptFor(ctx, resolved), { hidden: true });
  if (value === "") fail("refusing to store an empty value");

  // Keychain first: if this fails there must be no rule pointing at a secret that
  // isn't there. `set` verifies its own round-trip and throws if it can't.
  ctx.secretStore().set(resolved.dir, resolved.name, value);

  let stored: Rule | undefined;
  let replaced: Rule | undefined;
  try {
    updateRules(ctx.rulesPath, (file) => {
      const existing = findRule(file, resolved.dir, resolved.name);
      const rule: Rule = { dir: resolved.dir, name: resolved.name, source: "keychain" };
      const alias = nextAlias(resolved, existing);
      if (alias) rule.alias = alias;
      stored = rule;
      const result = upsertRule(file, rule);
      replaced = result.replaced;
      return result.file;
    });
  } catch (err) {
    ctx.err(
      `slopenv: the keychain entry for ${resolved.name} was written but the rules file was not updated — ` +
        `remove the orphan with: slopenv rm ${resolved.name} ${resolved.dir}\n`,
    );
    throw err;
  }

  warnIfBrokeLink(ctx, replaced);
  ctx.out(`${describe(stored as Rule, maskSecret(value))}\n`);
  if (!hookIsActive(ctx.env)) ctx.err(hookInactiveNotice());
  return 0;
}

function setPlain(ctx: Context, resolved: Resolved): number {
  warnIfRisky(ctx, resolved.name);

  // Plain values are not secret, so the prompt echoes — you can see what you type.
  const value = resolved.value ?? readValue(promptFor(ctx, resolved), { hidden: false });
  confirmPlaintext(ctx, resolved, value);

  let stored: Rule | undefined;
  let replaced: Rule | undefined;

  updateRules(ctx.rulesPath, (file) => {
    const existing = findRule(file, resolved.dir, resolved.name);
    const rule: Rule = { dir: resolved.dir, name: resolved.name, source: "plain", value };
    const alias = nextAlias(resolved, existing);
    if (alias) rule.alias = alias;
    stored = rule;
    const result = upsertRule(file, rule);
    replaced = result.replaced;
    return result.file;
  });

  // A plain rule replacing a secret must not leave the secret behind in the keychain.
  if (usesKeychain(replaced)) {
    try {
      ctx.secretStore().remove(resolved.dir, resolved.name);
      ctx.err(`slopenv: replaced a keychain rule — deleted the keychain entry for ${resolved.name}\n`);
    } catch (err) {
      ctx.err(
        `slopenv: could not delete the replaced keychain entry for ${resolved.name}: ${(err as Error).message}\n`,
      );
    }
  }

  warnIfBrokeLink(ctx, replaced);
  ctx.out(`${describe(stored as Rule, value)}\n`);
  if (!hookIsActive(ctx.env)) ctx.err(hookInactiveNotice());
  return 0;
}

function countLinks(n: number): string {
  return n === 1 ? "1 rule links" : `${n} rules link`;
}

/**
 * Point a second directory at a value that already exists somewhere else.
 *
 * A link, not a copy: one value, N directories. Copying a keychain rule would put
 * a second copy of the same secret in the keychain and give you two places to
 * rotate it, which is exactly the thing this tool exists to avoid.
 */
export function cmdLink(argv: readonly string[], ctx: Context): number {
  const usage = "usage: slopenv link NAME --from SRCDIR [DIR] [--alias TEXT]";
  const args = parseArgs(argv, { value: ["from", "dir", "alias"] });

  const name = args.positional[0];
  if (!name) fail(usage);
  if (args.positional.length > 2) fail(usage);
  assertValidName(name);

  const from = args.values.from;
  if (from === undefined) {
    fail(`link needs the directory to borrow from:  slopenv link ${name} --from DIR`);
  }

  const dir = resolveRuleDir(args.values.dir ?? args.positional[1] ?? ".", ctx.cwd);
  const fromDir = resolveRuleDir(from, ctx.cwd);

  const file = loadRules(ctx.rulesPath);

  // `--from` takes any directory the source rule covers, not just the directory
  // it is registered for, so `--from ~/dev/threa/apps` finds the rule at
  // ~/dev/threa. Same resolution the shell hook does on every cd.
  const holder = resolveRules(file.rules, fromDir).get(name);
  if (!holder) {
    fail(
      `no rule for ${name} in ${fromDir}.\n` +
        `  \`link\` borrows an existing value; it does not create one.\n` +
        `  See what is there with:  slopenv status ${fromDir}`,
    );
  }

  // Flatten: a link's target is always a real rule, so links never chain and
  // cannot cycle.
  const target = holder.source === "link" ? (holder.target as string) : holder.dir;

  if (target === dir) fail(`${name} already lives in ${dir} — there is nothing to link to`);

  const existing = findRule(file, dir, name);
  const dependents = linksTo(file.rules, dir, name);
  if (dependents.length > 0) {
    fail(
      `${countLinks(dependents.length)} to ${name} in ${dir}, so it cannot become a link itself:\n` +
        dependents.map((r) => `      ${r.dir}`).join("\n") +
        `\n  Re-point or remove them first.`,
    );
  }

  warnIfRisky(ctx, name);
  if (dirCovers(target, dir)) {
    ctx.err(`slopenv: heads up — the rule in ${target} already covers ${dir}, so this link changes nothing today\n`);
  }

  // No alias of its own means `list` shows the target's — the label describes the
  // value, and there is only one value.
  const rule: Rule = { dir, name, source: "link", target };
  const alias = args.values.alias !== undefined ? args.values.alias || undefined : existing?.alias;
  if (alias) rule.alias = alias;

  let replaced: Rule | undefined;
  updateRules(ctx.rulesPath, (current) => {
    const result = upsertRule(current, rule);
    replaced = result.replaced;
    return result.file;
  });

  // Same rule as `set`: a rule that stops holding its own value must not leave a
  // secret behind in the keychain.
  if (usesKeychain(replaced)) {
    try {
      ctx.secretStore().remove(dir, name);
      ctx.err(`slopenv: replaced a keychain rule — deleted the keychain entry for ${name}\n`);
    } catch (err) {
      ctx.err(`slopenv: could not delete the replaced keychain entry for ${name}: ${(err as Error).message}\n`);
    }
  }

  ctx.out(`${name} -> ${target}  [link]  ${dir}${rule.alias ? `  ${rule.alias}` : ""}\n`);
  if (!hookIsActive(ctx.env)) ctx.err(hookInactiveNotice());
  return 0;
}

export function cmdRm(argv: readonly string[], ctx: Context): number {
  const usage = "usage: slopenv rm NAME [DIR] [--force]";
  const args = parseArgs(argv, { value: ["dir"], boolean: ["force"], short: { f: "force" } });
  const name = args.positional[0];
  if (!name) fail(usage);
  if (args.positional.length > 2) fail(usage);

  // Removal tolerates a directory that no longer exists — that is often exactly
  // why you are removing the rule.
  const dir = resolveRuleDir(args.values.dir ?? args.positional[1] ?? ".", ctx.cwd, { mustExist: false });

  // Rules that link here would be left pointing at nothing, which is a state the
  // rules file refuses to load at all. Say so instead of creating it.
  const dependents = linksTo(loadRules(ctx.rulesPath).rules, dir, name);
  if (dependents.length > 0 && !args.flags.has("force")) {
    fail(
      `${countLinks(dependents.length)} to ${name} in ${dir}:\n` +
        dependents.map((r) => `      ${r.dir}`).join("\n") +
        `\n  Remove them first, or remove all of them together with: slopenv rm ${name} ${dir} --force`,
    );
  }

  let removed: Rule | undefined;
  // What gets cascaded is decided under the lock, so the report is what happened
  // rather than what the check above saw a moment earlier.
  let cascaded: Rule[] = [];
  updateRules(ctx.rulesPath, (file) => {
    const result = removeRule(file, dir, name);
    removed = result.removed;
    if (!removed) return result.file;

    cascaded = linksTo(result.file.rules, dir, name);
    let rules = result.file;
    for (const dependent of cascaded) rules = removeRule(rules, dependent.dir, name).file;
    return rules;
  });

  if (!removed) fail(`no rule for ${name} in ${dir}`);

  const alsoRemoved = cascaded.length === 0 ? "" : `, and ${cascaded.length} link${cascaded.length === 1 ? "" : "s"} to it`;
  if (usesKeychain(removed)) {
    ctx.secretStore().remove(dir, name);
    const what = removed.source === "vault" ? "its cached value" : "its keychain entry";
    ctx.out(`removed ${name} (${dir}) and ${what}${alsoRemoved}\n`);
  } else {
    ctx.out(`removed ${name} (${dir})${alsoRemoved}\n`);
  }
  for (const dependent of cascaded) ctx.out(`  also removed the link in ${dependent.dir}\n`);
  return 0;
}
