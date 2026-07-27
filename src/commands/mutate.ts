import { parseArgs } from "../args.ts";
import type { Context } from "../context.ts";
import { fail } from "../errors.ts";
import { isDirectory, resolveRuleDir } from "../paths.ts";
import { describeSuspicion, detectSecretish } from "../secretish.ts";
import { confirm, isInteractive, maskSecret, readValue } from "../prompt.ts";
import {
  assertValidName,
  loadRules,
  removeRule,
  RISKY_NAMES,
  ruleKey,
  updateRules,
  upsertRule,
  type Rule,
  type RulesFile,
} from "../rules.ts";

const MUTATE_SPEC = {
  value: ["dir", "value", "alias"],
  boolean: ["yes", "force"],
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

  return {
    name,
    dir: resolveRuleDir(dir ?? ".", ctx.cwd),
    value,
    alias: args.values.alias,
    aliasGiven: args.values.alias !== undefined,
    assumeYes: args.flags.has("yes") || args.flags.has("force"),
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
  ctx.err(`  To put it in the keychain instead:  slopenv set-secret ${resolved.name} ${resolved.dir}\n`);

  if (!isInteractive()) {
    fail(`refusing to store what looks like a credential in plain text. Pass --yes to override, or use \`set-secret\`.`);
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
  try {
    existing = findRule(loadRules(ctx.rulesPath), resolved.dir, resolved.name);
  } catch {
    return undefined; // A broken rules file is not worth failing a prompt over.
  }
  if (!existing) return undefined;
  if (existing.source === "plain") return existing.value;

  try {
    const stored = ctx.secretStore().get(resolved.dir, resolved.name);
    return stored === null ? undefined : maskSecret(stored);
  } catch {
    return undefined;
  }
}

export function cmdSetSecret(argv: readonly string[], ctx: Context): number {
  const usage = "usage: slopenv set-secret NAME[=VALUE] [DIR] [--alias TEXT]";
  const resolved = resolveMutateArgs(argv, ctx, usage, "set-secret");
  warnIfRisky(ctx, resolved.name);

  const value = resolved.value ?? readValue(promptFor(ctx, resolved), { hidden: true });
  if (value === "") fail("refusing to store an empty value");

  // Keychain first: if this fails there must be no rule pointing at a secret that
  // isn't there. `set` verifies its own round-trip and throws if it can't.
  ctx.secretStore().set(resolved.dir, resolved.name, value);

  let stored: Rule | undefined;
  try {
    updateRules(ctx.rulesPath, (file) => {
      const existing = findRule(file, resolved.dir, resolved.name);
      const rule: Rule = { dir: resolved.dir, name: resolved.name, source: "keychain" };
      const alias = nextAlias(resolved, existing);
      if (alias) rule.alias = alias;
      stored = rule;
      return upsertRule(file, rule).file;
    });
  } catch (err) {
    ctx.err(
      `slopenv: the keychain entry for ${resolved.name} was written but the rules file was not updated — ` +
        `remove the orphan with: slopenv rm ${resolved.name} ${resolved.dir}\n`,
    );
    throw err;
  }

  ctx.out(`${describe(stored as Rule, maskSecret(value))}\n`);
  return 0;
}

export function cmdSet(argv: readonly string[], ctx: Context): number {
  const usage = "usage: slopenv set NAME[=VALUE] [DIR] [--alias TEXT]";
  const resolved = resolveMutateArgs(argv, ctx, usage, "set");
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
  if (replaced?.source === "keychain") {
    try {
      ctx.secretStore().remove(resolved.dir, resolved.name);
      ctx.err(`slopenv: replaced a keychain rule — deleted the keychain entry for ${resolved.name}\n`);
    } catch (err) {
      ctx.err(
        `slopenv: could not delete the replaced keychain entry for ${resolved.name}: ${(err as Error).message}\n`,
      );
    }
  }

  ctx.out(`${describe(stored as Rule, value)}\n`);
  return 0;
}

export function cmdRm(argv: readonly string[], ctx: Context): number {
  const args = parseArgs(argv, { value: ["dir"] });
  const name = args.positional[0];
  if (!name) fail("usage: slopenv rm NAME [DIR]");
  if (args.positional.length > 2) fail("usage: slopenv rm NAME [DIR]");

  // Removal tolerates a directory that no longer exists — that is often exactly
  // why you are removing the rule.
  const dir = resolveRuleDir(args.values.dir ?? args.positional[1] ?? ".", ctx.cwd, { mustExist: false });

  let removed: Rule | undefined;
  updateRules(ctx.rulesPath, (file) => {
    const result = removeRule(file, dir, name);
    removed = result.removed;
    return result.file;
  });

  if (!removed) fail(`no rule for ${name} in ${dir}`);

  if (removed.source === "keychain") {
    ctx.secretStore().remove(dir, name);
    ctx.out(`removed ${name} (${dir}) and its keychain entry\n`);
  } else {
    ctx.out(`removed ${name} (${dir})\n`);
  }
  return 0;
}
