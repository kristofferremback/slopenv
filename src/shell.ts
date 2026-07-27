/**
 * Emitting shell statements that get `eval`d. Quoting bugs here are arbitrary code
 * execution, so there is exactly one rule and no exceptions to it.
 */

/**
 * POSIX single-quote a value.
 *
 * Inside single quotes every byte is literal and the only character that cannot
 * appear is `'` itself, which we close, escape and reopen around: `'\''`.
 * Newlines, `$`, backticks, backslashes and `!` all survive untouched.
 */
export function shellQuote(value: string): string {
  return `'${value.split("'").join(`'\\''`)}'`;
}

export function exportStatement(name: string, value: string): string {
  return `export ${name}=${shellQuote(value)}`;
}

export function unsetStatement(name: string): string {
  return `unset ${name}`;
}
