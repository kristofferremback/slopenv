import type { Rule } from "./rules.ts";

/**
 * Does `rule.dir` cover `pwd`?
 *
 * Whole-segment prefix match, which is the only reason `/dev/threa` does not
 * match `/dev/threa-2`. Both paths are expected to be absolute and already
 * symlink-resolved.
 */
export function dirCovers(ruleDir: string, pwd: string): boolean {
  if (ruleDir === pwd) return true;
  const prefix = ruleDir.endsWith("/") ? ruleDir : `${ruleDir}/`;
  return pwd.startsWith(prefix);
}

/** Rules whose directory covers `pwd`, deepest directory first. */
export function matchingRules(rules: readonly Rule[], pwd: string): Rule[] {
  return rules
    .filter((r) => dirCovers(r.dir, pwd))
    .sort((a, b) => b.dir.length - a.dir.length || a.name.localeCompare(b.name));
}

/**
 * The winning rule per variable name for `pwd`.
 *
 * Every matching directory is a prefix of `pwd`, so the longest string is also
 * the deepest directory — a nested rule wins over its ancestor.
 */
export function resolveRules(rules: readonly Rule[], pwd: string): Map<string, Rule> {
  const winner = new Map<string, Rule>();
  for (const rule of matchingRules(rules, pwd)) {
    if (!winner.has(rule.name)) winner.set(rule.name, rule);
  }
  return winner;
}

/** Every distinct rule directory, sorted — the list the shell hook caches. */
export function ruleDirs(rules: readonly Rule[]): string[] {
  return [...new Set(rules.map((r) => r.dir))].sort();
}
