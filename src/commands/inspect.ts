import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { parseArgs } from "../args.ts";
import type { Context } from "../context.ts";
import { dirCovers, resolveRules } from "../match.ts";
import { resolvePwd, resolveRuleDir } from "../paths.ts";
import { maskSecret } from "../prompt.ts";
import { loadRules, type Rule } from "../rules.ts";
import { describeSuspicion, detectSecretish } from "../secretish.ts";
import { decodeState, hookInactiveNotice, hookIsActive, STATE_VAR } from "../state.ts";

function tilde(path: string, home = homedir()): string {
  return path === home || path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
}

function sortRules(rules: readonly Rule[]): Rule[] {
  return [...rules].sort((a, b) => a.dir.localeCompare(b.dir) || a.name.localeCompare(b.name));
}

/** Render a table without letting one long cell wreck the alignment of the rest. */
function table(rows: readonly string[][], out: (text: string) => void): void {
  if (rows.length === 0) return;
  const widths: number[] = [];
  for (const row of rows) {
    row.forEach((cell, i) => {
      widths[i] = Math.max(widths[i] ?? 0, [...cell].length);
    });
  }
  for (const row of rows) {
    const line = row
      .map((cell, i) => (i === row.length - 1 ? cell : cell.padEnd(widths[i] ?? 0)))
      .join("  ")
      .trimEnd();
    out(`${line}\n`);
  }
}

/**
 * Show every rule. Secret values are never printed in full — a keychain rule gets
 * `•••` plus the last four characters, which is enough to tell two tokens apart
 * and not enough to use one.
 */
export function cmdList(argv: readonly string[], ctx: Context): number {
  const args = parseArgs(argv, { boolean: ["json"] });
  const rules = sortRules(loadRules(ctx.rulesPath).rules);

  if (args.flags.has("json")) {
    // Deliberately never resolves keychain values — machine-readable output is
    // the last place a secret should leak into.
    ctx.out(`${JSON.stringify({ rulesPath: ctx.rulesPath, rules }, null, 2)}\n`);
    return 0;
  }

  if (rules.length === 0) {
    ctx.out(`no rules yet (${tilde(ctx.rulesPath)})\n`);
    ctx.out(`add one with:  slopenv set-secret MY_TOKEN ./\n`);
    return 0;
  }

  const rows: string[][] = [["DIRECTORY", "VARIABLE", "SOURCE", "VALUE", "ALIAS"]];
  for (const rule of rules) {
    let shown: string;
    if (rule.source === "plain") {
      shown = rule.value ?? "";
    } else {
      try {
        const value = ctx.secretStore().get(rule.dir, rule.name);
        shown = value === null ? "<missing>" : maskSecret(value);
      } catch {
        shown = "<unreadable>";
      }
    }
    rows.push([tilde(rule.dir), rule.name, rule.source, shown, rule.alias ?? ""]);
  }

  table(rows, ctx.out);
  if (!hookIsActive(ctx.env)) ctx.err(`\n${hookInactiveNotice()}`);
  return 0;
}

/** What is active in a directory right now, and which rule put it there. */
export function cmdStatus(argv: readonly string[], ctx: Context): number {
  const args = parseArgs(argv, {});
  const pwd = args.positional[0] ? resolveRuleDir(args.positional[0], ctx.cwd, { mustExist: false }) : resolvePwd(ctx.cwd);

  const rules = loadRules(ctx.rulesPath).rules;
  const active = resolveRules(rules, pwd);
  const state = decodeState(ctx.env[STATE_VAR]);

  ctx.out(`directory:  ${tilde(pwd)}\n`);
  ctx.out(`rules file: ${tilde(ctx.rulesPath)}\n`);
  ctx.out(`hook:       ${ctx.env[STATE_VAR] ? "active in this shell" : "not active in this shell"}\n`);

  if (active.size === 0) {
    ctx.out(`\nno rules apply here\n`);
    return 0;
  }

  ctx.out("\n");
  const rows: string[][] = [["VARIABLE", "SOURCE", "VALUE", "FROM", "IN SHELL", "ALIAS"]];
  for (const name of [...active.keys()].sort()) {
    const rule = active.get(name) as Rule;
    let shown: string;
    if (rule.source === "plain") {
      shown = rule.value ?? "";
    } else {
      try {
        const value = ctx.secretStore().get(rule.dir, rule.name);
        shown = value === null ? "<missing>" : maskSecret(value);
      } catch {
        shown = "<unreadable>";
      }
    }
    const inShell = state.active[name] !== undefined ? "yes" : "no";
    rows.push([name, rule.source, shown, tilde(rule.dir), inShell, rule.alias ?? ""]);
  }
  table(rows, ctx.out);

  // Rules that apply here but lost to a rule in a deeper directory.
  const shadowed = rules.filter((r) => dirCovers(r.dir, pwd) && active.get(r.name) !== undefined && active.get(r.name) !== r);
  if (shadowed.length > 0) {
    ctx.out(`\nshadowed by a deeper rule:\n`);
    for (const rule of sortRules(shadowed)) ctx.out(`  ${rule.name} from ${tilde(rule.dir)}\n`);
  }

  return 0;
}


/**
 * One command that checks the whole install, because the failure modes are spread
 * across three places: the rules file, the keychain, and the shell hook.
 */
export function cmdDoctor(_argv: readonly string[], ctx: Context): number {
  let problems = 0;
  const ok = (text: string) => ctx.out(`  ok    ${text}\n`);
  const bad = (text: string) => {
    problems++;
    ctx.out(`  FAIL  ${text}\n`);
  };
  const note = (text: string) => ctx.out(`  note  ${text}\n`);

  ctx.out(`slopenv doctor\n\n`);

  ctx.out(`shell hook\n`);
  if (ctx.env[STATE_VAR]) ok("hook is active in this shell");
  else bad(`hook is not active in this shell — add  eval "$(slopenv hook zsh)"  to ~/.zshrc`);

  ctx.out(`\nrules file (${tilde(ctx.rulesPath)})\n`);
  if (!existsSync(ctx.rulesPath)) {
    note("does not exist yet — it is created on the first `slopenv set`");
  } else {
    const mode = statSync(ctx.rulesPath).mode & 0o777;
    if (mode === 0o600) ok("permissions are 0600");
    else bad(`permissions are 0${mode.toString(8)}, expected 0600 — run: chmod 600 ${ctx.rulesPath}`);
  }

  let rules: Rule[] = [];
  try {
    rules = loadRules(ctx.rulesPath).rules;
    ok(`parses cleanly (${rules.length} rule${rules.length === 1 ? "" : "s"})`);
  } catch (err) {
    bad((err as Error).message);
    ctx.out(`\n${problems} problem${problems === 1 ? "" : "s"} found\n`);
    return 1;
  }

  const missingDirs = rules.filter((r) => !existsSync(r.dir));
  if (missingDirs.length > 0) {
    ctx.out(`\nrule directories\n`);
    for (const rule of sortRules(missingDirs)) {
      bad(`${rule.name}: directory no longer exists — ${rule.dir}`);
    }
  }

  // `set` asks before storing one of these, but `edit` and hand-editing bypass
  // that entirely — so check the file itself, not just the way in.
  const suspicious = rules
    .filter((r) => r.source === "plain")
    .map((r) => ({ rule: r, suspicion: detectSecretish(r.name, r.value ?? "") }))
    .filter((x) => x.suspicion !== null);

  if (suspicious.length > 0) {
    ctx.out(`\nplain-text values\n`);
    for (const { rule, suspicion } of suspicious) {
      bad(
        `${describeSuspicion(rule.name, suspicion as NonNullable<typeof suspicion>)}, stored in plain text ` +
          `(${tilde(rule.dir)}) — move it with: slopenv set-secret ${rule.name} ${rule.dir}`,
      );
    }
  }

  const secrets = rules.filter((r) => r.source === "keychain");
  if (secrets.length > 0) {
    ctx.out(`\nkeychain (${secrets.length} secret rule${secrets.length === 1 ? "" : "s"})\n`);
    for (const rule of sortRules(secrets)) {
      try {
        const value = ctx.secretStore().get(rule.dir, rule.name);
        if (value === null) bad(`${rule.name} (${tilde(rule.dir)}): no keychain entry — re-add with \`slopenv set-secret ${rule.name} ${rule.dir}\``);
        else ok(`${rule.name} (${tilde(rule.dir)}): ${maskSecret(value)}`);
      } catch (err) {
        bad(`${rule.name} (${tilde(rule.dir)}): ${(err as Error).message}`);
      }
    }
    // Enumerating every generic password to find orphans would need
    // `security dump-keychain`, which prompts for permission item by item — not
    // something a health check should do to you.
    note("orphaned keychain entries are not detected; `security dump-keychain` would prompt for every item");
  }

  ctx.out(`\n${problems === 0 ? "no problems found" : `${problems} problem${problems === 1 ? "" : "s"} found`}\n`);
  return problems === 0 ? 0 : 1;
}
