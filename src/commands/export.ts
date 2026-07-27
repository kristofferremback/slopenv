import type { Context } from "../context.ts";
import { computePlan } from "../engine.ts";
import { debug } from "../log.ts";
import { dirCovers, ruleDirs } from "../match.ts";
import { resolvePwd } from "../paths.ts";
import { fingerprint, loadRules } from "../rules.ts";
import { exportStatement } from "../shell.ts";
import { decodeState, encodeState, STATE_VAR } from "../state.ts";

/**
 * The hot path: run on every `cd`, its stdout is `eval`d by the shell.
 *
 * Two hard rules. Nothing but shell statements ever reaches stdout — every
 * diagnostic goes to stderr. And if anything at all goes wrong we exit non-zero
 * with empty stdout, because the hook skips the `eval` on a non-zero exit; a
 * partial script is the one thing that could wedge a shell.
 */
export function cmdExport(argv: readonly string[], ctx: Context): number {
  const pwd = resolvePwd(argv[0] ?? ctx.cwd);
  const rev = fingerprint(ctx.rulesPath);
  const rules = loadRules(ctx.rulesPath).rules;
  const prevState = decodeState(ctx.env[STATE_VAR]);

  debug(`export pwd=${pwd} rev=${rev} rules=${rules.length} active=${Object.keys(prevState.active).length}`);

  const plan = computePlan({
    rules,
    pwd,
    prevState,
    env: ctx.env,
    store: ctx.secretStore(),
    rev,
  });

  for (const warning of plan.warnings) ctx.err(`slopenv: ${warning}\n`);

  const dirs = ruleDirs(rules);
  // Must be byte-identical to what the zsh hook builds, or its fast path breaks:
  // matching dirs in the same (sorted) order, each followed by a newline.
  const match = dirs.filter((dir) => dirCovers(dir, pwd)).map((dir) => `${dir}\n`).join("");

  const lines = [
    ...plan.statements,
    exportStatement(STATE_VAR, encodeState(plan.state)),
    exportStatement("SLOPENV_FP", rev),
    exportStatement("SLOPENV_DIRS", dirs.join("\n")),
    exportStatement("SLOPENV_MATCH", match),
    exportStatement("SLOPENV_CONFIG", ctx.rulesPath),
  ];

  ctx.out(`${lines.join("\n")}\n`);
  return 0;
}
