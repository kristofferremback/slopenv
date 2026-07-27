/**
 * An error that is the user's problem, not a crash. `cli.ts` prints these as a
 * plain `slopenv: <message>` line on stderr with no stack trace; anything else
 * that escapes is a bug and gets the full stack.
 */
export class SlopenvError extends Error {
  override name = "SlopenvError";
}

export function fail(message: string): never {
  throw new SlopenvError(message);
}
