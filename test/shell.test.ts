import { describe, expect, test } from "bun:test";
import { exportStatement, shellQuote, unsetStatement } from "../src/shell.ts";

/**
 * These values are the reason the emitter uses single quotes and nothing else.
 * Each one is fed to a real zsh below, because "looks right" is not a standard
 * that applies to something the shell is about to `eval`.
 */
const NASTY_VALUES: Record<string, string> = {
  plain: "sk-ant-oat01-abcdef",
  single_quote: "it's",
  many_quotes: "''''",
  double_quote: 'say "hi"',
  dollar: "$HOME and ${PATH} and $(rm -rf /)",
  backtick: "`whoami`",
  backslash: "a\\b\\\\c",
  newline: "line1\nline2",
  tab: "a\tb",
  semicolon: "a; echo pwned; :",
  ampersand: "a && echo pwned",
  pipe: "a | echo pwned",
  redirect: "a > /tmp/pwned",
  glob: "*",
  bang: "history! expansion",
  unicode: "héllo-wörld-日本",
  spaces: "  leading and trailing  ",
  empty: "",
  subshell_close: "')'; echo pwned; :'",
};

describe("shellQuote", () => {
  test("wraps in single quotes and escapes only the quote character", () => {
    expect(shellQuote("abc")).toBe("'abc'");
    expect(shellQuote("it's")).toBe(`'it'\\''s'`);
    expect(shellQuote("")).toBe("''");
    expect(shellQuote("$PATH")).toBe("'$PATH'");
  });

  test("unsetStatement is a bare unset", () => {
    expect(unsetStatement("FOO")).toBe("unset FOO");
  });
});

describe("emitted statements survive a real shell", () => {
  for (const [label, value] of Object.entries(NASTY_VALUES)) {
    test(`zsh eval round-trips: ${label}`, () => {
      const script = `${exportStatement("SLOPENV_TEST_VALUE", value)}\nprintf '%s' "$SLOPENV_TEST_VALUE"\n`;
      const proc = Bun.spawnSync(["/bin/zsh", "-f", "-c", script], { stdout: "pipe", stderr: "pipe" });
      expect(proc.stderr.toString()).toBe("");
      expect(proc.exitCode).toBe(0);
      expect(proc.stdout.toString()).toBe(value);
    });
  }

  test("bash eval round-trips the same values", () => {
    for (const value of Object.values(NASTY_VALUES)) {
      const script = `${exportStatement("SLOPENV_TEST_VALUE", value)}\nprintf '%s' "$SLOPENV_TEST_VALUE"\n`;
      const proc = Bun.spawnSync(["/bin/bash", "--noprofile", "--norc", "-c", script], {
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(proc.exitCode).toBe(0);
      expect(proc.stdout.toString()).toBe(value);
    }
  });

  test("a value that tries to break out of the quoting does not execute", () => {
    const attack = `'; touch /tmp/slopenv-pwned-$$; echo '`;
    const script = `${exportStatement("SLOPENV_TEST_VALUE", attack)}\nprintf '%s' "$SLOPENV_TEST_VALUE"\n`;
    const proc = Bun.spawnSync(["/bin/zsh", "-f", "-c", script], { stdout: "pipe", stderr: "pipe" });
    expect(proc.exitCode).toBe(0);
    expect(proc.stdout.toString()).toBe(attack);
  });
});
