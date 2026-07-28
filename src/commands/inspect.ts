import { existsSync, statSync } from "node:fs";
import { parseArgs } from "../args.ts";
import type { Context } from "../context.ts";
import { dirCovers, resolveRules } from "../match.ts";
import { resolvePwd, resolveRuleDir, tilde } from "../paths.ts";
import { maskSecret } from "../prompt.ts";
import { effectiveRule, loadRules, type Rule } from "../rules.ts";
import { describeSuspicion, detectSecretish } from "../secretish.ts";
import { decodeState, hookInactiveNotice, hookIsActive, STATE_VAR } from "../state.ts";

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
 * The value a rule produces, ready to print: masked for a secret, followed through
 * for a link. Never throws — an unreadable keychain should not take down `list`.
 */
function shownValue(ctx: Context, rules: readonly Rule[], rule: Rule): string {
  const holder = effectiveRule(rules, rule);
  if (!holder) return "<broken link>";
  if (holder.source === "plain") return holder.value ?? "";
  try {
    const value = ctx.secretStore().get(holder.dir, holder.name);
    return value === null ? "<missing>" : maskSecret(value);
  } catch {
    return "<unreadable>";
  }
}

/** A link has no label of its own unless you gave it one; the value's label applies. */
function shownAlias(rules: readonly Rule[], rule: Rule): string {
  return rule.alias ?? (rule.source === "link" ? (effectiveRule(rules, rule)?.alias ?? "") : "");
}

/**
 * Show every rule. Secret values are never printed in full — a keychain rule gets
 * `•••` plus the last four characters, which is enough to tell two tokens apart
 * and not enough to use one.
 */
export function cmdList(argv: readonly string[], ctx: Context): number {
  const args = parseArgs(argv, { boolean: ["json", "names", "dirs"] });
  const rules = sortRules(loadRules(ctx.rulesPath).rules);

  // Plain lists for scripting and for shell completion. Neither touches the
  // keychain, so they stay fast enough to sit behind a TAB press.
  if (args.flags.has("names")) {
    for (const name of [...new Set(rules.map((r) => r.name))].sort()) ctx.out(`${name}\n`);
    return 0;
  }
  if (args.flags.has("dirs")) {
    for (const dir of [...new Set(rules.map((r) => r.dir))].sort()) ctx.out(`${dir}\n`);
    return 0;
  }

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

  // The BORROWS FROM column only appears once there is a link to put in it.
  const anyLinks = rules.some((r) => r.source === "link");
  const header = ["DIRECTORY", "VARIABLE", "SOURCE", "VALUE", "ALIAS"];
  if (anyLinks) header.splice(3, 0, "BORROWS FROM");

  const rows: string[][] = [header];
  for (const rule of rules) {
    const row = [tilde(rule.dir), rule.name, rule.source, shownValue(ctx, rules, rule), shownAlias(rules, rule)];
    if (anyLinks) row.splice(3, 0, rule.target ? tilde(rule.target) : "");
    rows.push(row);
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

  // Worth its own line rather than leaving you to infer it from a column of "no":
  // a pause is invisible otherwise, and it is the reason nothing is set.
  const pausedAt = state.paused !== null && dirCovers(state.paused, pwd) ? state.paused : null;
  if (pausedAt !== null) {
    ctx.out(`paused:     yes — off in this shell since ${tilde(pausedAt)}\n`);
    ctx.out(`            back on when you leave it, or now with: slopenv on\n`);
  }

  if (active.size === 0) {
    ctx.out(`\nno rules apply here\n`);
    return 0;
  }

  ctx.out("\n");
  const rows: string[][] = [["VARIABLE", "SOURCE", "VALUE", "FROM", "IN SHELL", "ALIAS"]];
  for (const name of [...active.keys()].sort()) {
    const rule = active.get(name) as Rule;
    const inShell = state.active[name] !== undefined ? "yes" : "no";
    // For a link, FROM is the whole path the value takes to get here.
    const from = rule.target ? `${tilde(rule.dir)} -> ${tilde(rule.target)}` : tilde(rule.dir);
    rows.push([name, rule.source, shownValue(ctx, rules, rule), from, inShell, shownAlias(rules, rule)]);
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

  // Not a problem — a state you asked for. But it is the first thing to rule out
  // when the answer to "why is nothing set" is "because you turned it off".
  const paused = decodeState(ctx.env[STATE_VAR]).paused;
  if (paused !== null) note(`off in this shell since ${tilde(paused)} — \`slopenv on\` to load again`);

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

  const links = rules.filter((r) => r.source === "link");
  if (links.length > 0) {
    ctx.out(`\nlinks (${links.length})\n`);
    for (const rule of sortRules(links)) {
      const holder = effectiveRule(rules, rule);
      // Unreachable through `loadRules`, which refuses a file with a dangling
      // link. Checked anyway: doctor is where "cannot happen" gets verified.
      if (!holder) bad(`${rule.name} (${tilde(rule.dir)}): links to ${tilde(rule.target ?? "?")}, where there is no rule for it`);
      else ok(`${rule.name} (${tilde(rule.dir)}) borrows from ${tilde(holder.dir)} [${holder.source}]`);
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
