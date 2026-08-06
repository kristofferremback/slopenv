import type { Context } from "../context.ts";
import { computePlan, type Plan } from "../engine.ts";
import { debug } from "../log.ts";
import { dirCovers, ruleDirs } from "../match.ts";
import { resolvePwd } from "../paths.ts";
import { fingerprint, loadRules } from "../rules.ts";
import { exportStatement } from "../shell.ts";
import { decodeState, encodeState, pauseEndedNotice, STATE_VAR, type State } from "../state.ts";

/**
 * Compute the plan for `pwd` and write it, statements to stdout and everything
 * else to stderr.
 *
 * Shared by `export`, `off` and `on`, which differ only in the state they start
 * from — `off` adds a pause to it, `on` takes one away. Emitting through one path
 * is what keeps them from drifting into three slightly different ideas of what the
 * shell should end up with.
 */
export async function emitPlan(ctx: Context, pwd: string, prevState: State): Promise<Plan> {
  const rev = fingerprint(ctx.rulesPath);
  const rules = loadRules(ctx.rulesPath).rules;

  debug(
    `emit pwd=${pwd} rev=${rev} rules=${rules.length} active=${Object.keys(prevState.active).length} ` +
      `paused=${prevState.paused ?? "no"}`,
  );

  const plan = await computePlan({
    rules,
    pwd,
    prevState,
    env: ctx.env,
    store: ctx.secretStore(),
    rev,
  });

  for (const warning of plan.warnings) ctx.err(`slopenv: ${warning}\n`);
  if (plan.resumedFrom !== null) ctx.err(pauseEndedNotice(plan.resumedFrom));

  const dirs = ruleDirs(rules);

  // The paused directory has to be in the list the hook watches, because that list
  // is what decides whether it bothers to call us at all. It is always a rule
  // directory when the pause is created — but if that rule is removed from another
  // terminal while the pause is live, leaving would no longer cross a boundary the
  // hook can see, and the pause would outlive the directory in silence.
  if (plan.state.paused !== null && !dirs.includes(plan.state.paused)) {
    dirs.push(plan.state.paused);
    dirs.sort();
  }

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
  return plan;
}

/**
 * The hot path: run on every `cd`, its stdout is `eval`d by the shell.
 *
 * Two hard rules. Nothing but shell statements ever reaches stdout — every
 * diagnostic goes to stderr. And if anything at all goes wrong we exit non-zero
 * with empty stdout, because the hook skips the `eval` on a non-zero exit; a
 * partial script is the one thing that could wedge a shell.
 */
export async function cmdExport(argv: readonly string[], ctx: Context): Promise<number> {
  const pwd = resolvePwd(argv[0] ?? ctx.cwd);
  await emitPlan(ctx, pwd, decodeState(ctx.env[STATE_VAR]));
  return 0;
}
