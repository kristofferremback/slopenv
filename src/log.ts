/**
 * Everything diagnostic goes to stderr. `slopenv export` writes shell statements
 * to stdout and the shell `eval`s them, so a single stray byte on stdout would be
 * executed. Nothing in this file ever touches stdout.
 */

function enabled(): boolean {
  const v = process.env.SLOPENV_LOG;
  return v !== undefined && v !== "" && v !== "0";
}

/** Debug tracing, only when SLOPENV_LOG=1. */
export function debug(message: string): void {
  if (enabled()) process.stderr.write(`slopenv[log]: ${message}\n`);
}

/** A problem the user should see, but which does not stop us. */
export function warn(message: string): void {
  process.stderr.write(`slopenv: ${message}\n`);
}
