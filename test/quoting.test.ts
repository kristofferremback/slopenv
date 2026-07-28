import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadRules } from "../src/rules.ts";
import { shellQuote } from "../src/shell.ts";
import { cleanup, tempDir } from "./helpers.ts";

/**
 * `NAME=VALUE` and quoting.
 *
 * The important thing these tests pin down is that quoting is entirely the
 * shell's job — by the time slopenv runs, `"FULL_NAME=Kristoffer Remback"` and
 * `FULL_NAME="Kristoffer Remback"` are the same single argument, and slopenv
 * cannot tell them apart. So they are exercised through a real zsh rather than
 * by hand-constructing argv, which would prove nothing about either form.
 */

const CLI = join(import.meta.dir, "..", "src", "cli.ts");

let root: string;
let rulesPath: string;
let proj: string;

beforeAll(() => {
  root = realpathSync(tempDir());
  rulesPath = join(root, "rules.json");
  proj = join(root, "proj");
  mkdirSync(join(proj, "apps"), { recursive: true });
});

afterAll(() => cleanup(root));

interface Result {
  code: number;
  stdout: string;
  stderr: string;
}

/** Run a command line through a real zsh, exactly as it would be typed. */
function typed(commandLine: string): Result {
  const script = `${shellQuote(process.execPath)} ${shellQuote(CLI)} ${commandLine}`;
  const proc = Bun.spawnSync(["/bin/zsh", "-f", "-c", script], {
    env: { ...process.env, SLOPENV_CONFIG: rulesPath },
    cwd: proj,
    stdout: "pipe",
    stderr: "pipe",
  });
  return { code: proc.exitCode ?? -1, stdout: proc.stdout.toString(), stderr: proc.stderr.toString() };
}

function valueOf(name: string): string | undefined {
  return loadRules(rulesPath).rules.find((r) => r.name === name)?.value;
}

describe("values with spaces", () => {
  test("the whole pair quoted", () => {
    expect(typed(`set "FULL_NAME=Kristoffer Remback"`).code).toBe(0);
    expect(valueOf("FULL_NAME")).toBe("Kristoffer Remback");
  });

  test("only the value quoted — identical to the shell, so identical to slopenv", () => {
    expect(typed(`set OTHER_NAME="Kristoffer Remback"`).code).toBe(0);
    expect(valueOf("OTHER_NAME")).toBe("Kristoffer Remback");
  });

  test("single quotes work too", () => {
    expect(typed(`set 'THIRD_NAME=Kristoffer Remback'`).code).toBe(0);
    expect(valueOf("THIRD_NAME")).toBe("Kristoffer Remback");
  });

  test("a quoted value keeps interior and edge whitespace exactly", () => {
    expect(typed(`set "PADDED=  two  spaces  "`).code).toBe(0);
    expect(valueOf("PADDED")).toBe("  two  spaces  ");
  });

  test("a quoted value plus an explicit directory", () => {
    expect(typed(`set "SCOPED=a b c" ./apps`).code).toBe(0);
    const rule = loadRules(rulesPath).rules.find((r) => r.name === "SCOPED");
    expect(rule?.value).toBe("a b c");
    expect(rule?.dir).toBe(join(proj, "apps"));
  });

  test("shell metacharacters inside a quoted value are not interpreted", () => {
    expect(typed(`set 'DANGER=$(touch ${root}/pwned) && echo hi'`).code).toBe(0);
    expect(valueOf("DANGER")).toBe(`$(touch ${root}/pwned) && echo hi`);
  });

  test("an alias with spaces needs no special handling either", () => {
    expect(typed(`set ALIASED=v --alias "Claude Code for work"`).code).toBe(0);
    expect(loadRules(rulesPath).rules.find((r) => r.name === "ALIASED")?.alias).toBe("Claude Code for work");
  });
});

describe("forgetting to quote", () => {
  test("fails, and the error names the actual mistake", () => {
    const result = typed(`set FULL_NAME=Kristoffer Remback`);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('"Remback" is not a directory');
    expect(result.stderr).toContain(`slopenv set "FULL_NAME=Kristoffer Remback"`);
    expect(result.stderr).toContain(`slopenv set FULL_NAME="Kristoffer Remback"`);
  });

  test("nothing is written when it fails", () => {
    typed(`set NEVER_STORED=Kristoffer Remback`);
    expect(valueOf("NEVER_STORED")).toBeUndefined();
  });

  test("the same hint covers several stray words", () => {
    const result = typed(`set SENTENCE=the quick brown fox`);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain(`slopenv set "SENTENCE=the quick brown fox"`);
  });

  test("the hint keeps --secret, so the suggested line still goes to the keychain", () => {
    const result = typed(`set --secret TOKEN=some value`);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain(`slopenv set --secret "TOKEN=some value"`);
  });

  test("the three-positional form gets the same hint", () => {
    const result = typed(`set NAME Kristoffer Remback`);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain(`slopenv set "NAME=Kristoffer Remback"`);
  });
});

describe("a path that was meant as a path", () => {
  test("gets a plain missing-directory error, not a lecture about quoting", () => {
    const result = typed(`set TOKEN=v ./typo-here`);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("directory does not exist");
    expect(result.stderr).not.toContain("quote");
  });

  test("an absolute path likewise", () => {
    const result = typed(`set TOKEN=v ${shellQuote(join(root, "nope"))}`);
    expect(result.stderr).toContain("directory does not exist");
    expect(result.stderr).not.toContain("quote");
  });

  test("a file is refused — a rule scoped to a file could never match", () => {
    const file = join(proj, "notes.txt");
    writeFileSync(file, "hi");
    const result = typed(`set TOKEN=v ./notes.txt`);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("not a directory");
  });
});

describe("the equals sign itself", () => {
  test("only the first one splits; the rest belong to the value", () => {
    expect(typed(`set "CONN=postgres://u:p@h/db?a=1&b=2" --yes`).code).toBe(0);
    expect(valueOf("CONN")).toBe("postgres://u:p@h/db?a=1&b=2");
  });

  test("a leading equals sign is a bad name, not an empty one", () => {
    const result = typed(`set "=orphan"`);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("invalid variable name");
  });

  test("a name with a space in it is refused", () => {
    const result = typed(`set "FULL NAME=x"`);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("invalid variable name");
  });

  test("literal quote characters in a value are preserved, never stripped", () => {
    // Reaching slopenv with real quotes takes escaping them past the shell first.
    expect(typed(`set 'JSON={"a": "b c"}'`).code).toBe(0);
    expect(valueOf("JSON")).toBe(`{"a": "b c"}`);
  });
});
