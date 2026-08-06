import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { shellQuote } from "../src/shell.ts";
import { cleanup, harness, tempDir, runAsync } from "./helpers.ts";

const CLI = join(import.meta.dir, "..", "src", "cli.ts");

let root: string;
let rulesPath: string;
let proj: string;

beforeAll(async () => {
  root = realpathSync(tempDir());
  rulesPath = join(root, "rules.json");
  proj = join(root, "proj");
  mkdirSync(join(proj, "apps"), { recursive: true });

  const h = harness({ rulesPath, cwd: proj, env: {} });
  await runAsync(["set", "NODE_ENV=development", proj], h.ctx);
  await runAsync(["set", "PORT=3000", join(proj, "apps")], h.ctx);
  await runAsync(["set", "FULL_NAME=Kris R", proj], h.ctx);
});

afterAll(() => cleanup(root));

async function cli(args: string[]): Promise<{ code: number; stdout: string }> {
  const h = harness({ rulesPath, cwd: proj, env: {} });
  const code = await runAsync(args, h.ctx);
  return { code, stdout: h.stdout() };
}

describe("the lists completion reads", () => {
  test("--names is one variable per line, sorted and deduplicated", async () => {
    expect((await cli(["list", "--names"])).stdout).toBe("FULL_NAME\nNODE_ENV\nPORT\n");
  });

  test("--dirs is one directory per line, sorted and deduplicated", async () => {
    // NODE_ENV and FULL_NAME share a directory; it must appear once.
    expect((await cli(["list", "--dirs"])).stdout).toBe(`${proj}\n${join(proj, "apps")}\n`);
  });

  test("neither reads the keychain, so both stay fast enough for a TAB press", async () => {
    const h = harness({ rulesPath, cwd: proj, env: {} });
    await runAsync(["set", "--secret", "SECRET_ONE=v", proj], h.ctx);
    h.store.reads.length = 0;

    await runAsync(["list", "--names"], h.ctx);
    await runAsync(["list", "--dirs"], h.ctx);
    expect(h.store.reads).toEqual([]);

    await runAsync(["rm", "SECRET_ONE", proj], h.ctx);
  });

  test("an empty rule set produces empty output rather than a message", async () => {
    const empty = join(root, "empty.json");
    writeFileSync(empty, JSON.stringify({ version: 1, rules: [] }));
    const h = harness({ rulesPath: empty, cwd: proj, env: {} });
    await runAsync(["list", "--names"], h.ctx);
    expect(h.stdout()).toBe("");
  });
});

describe("the generated scripts", () => {
  function generated(args: string[]): string {
    const proc = Bun.spawnSync(["bun", CLI, ...args], {
      env: { ...process.env, SLOPENV_CONFIG: rulesPath },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(proc.exitCode).toBe(0);
    return proc.stdout.toString();
  }

  function parses(shell: "zsh" | "bash", script: string): { ok: boolean; stderr: string } {
    const bin = shell === "zsh" ? "/bin/zsh" : "/bin/bash";
    const proc = Bun.spawnSync([bin, "-n"], {
      stdin: new TextEncoder().encode(script),
      stderr: "pipe",
    });
    return { ok: proc.exitCode === 0, stderr: proc.stderr.toString() };
  }

  test("the zsh completion is valid zsh", async () => {
    const result = parses("zsh", generated(["completions", "zsh"]));
    expect(result.stderr).toBe("");
    expect(result.ok).toBe(true);
  });

  test("the bash completion is valid bash", async () => {
    const result = parses("bash", generated(["completions", "bash"]));
    expect(result.stderr).toBe("");
    expect(result.ok).toBe(true);
  });

  test("the hooks embed them, so one line in ~/.zshrc gets both", async () => {
    const zsh = generated(["hook", "zsh"]);
    expect(zsh).toContain("compdef _slopenv slopenv");
    expect(parses("zsh", zsh).ok).toBe(true);

    expect(generated(["hook", "zsh", "--simple"])).toContain("compdef _slopenv slopenv");

    const bash = generated(["hook", "bash"]);
    expect(bash).toContain("complete -F _slopenv slopenv");
    expect(parses("bash", bash).ok).toBe(true);
  });

  test("registering is guarded, since compdef does not exist before compinit", async () => {
    // An error inside the `eval` at shell startup is a bad way to discover this.
    expect(generated(["completions", "zsh"])).toContain("$+functions[compdef]");
  });

  test("an unsupported shell is refused", async () => {
    const proc = Bun.spawnSync(["bun", CLI, "completions", "fish"], { stdout: "pipe", stderr: "pipe" });
    expect(proc.exitCode).toBe(1);
    expect(proc.stderr.toString()).toContain("expected zsh or bash");
  });
});

/**
 * Completion that loads is not the same as completion that works. These drive a
 * real interactive zsh through a pty and press TAB, which is the only way to see
 * what the completion system actually offers.
 */
describe("pressing TAB in a real zsh", () => {
  let zdotdir: string;

  beforeAll(async () => {
    zdotdir = join(root, "zdot");
    mkdirSync(zdotdir, { recursive: true });

    const completion = join(root, "completion.zsh");
    const proc = Bun.spawnSync(["bun", CLI, "completions", "zsh"], {
      env: { ...process.env, SLOPENV_CONFIG: rulesPath },
      stdout: "pipe",
    });
    writeFileSync(completion, proc.stdout.toString());

    // A `slopenv` on PATH that the completion can call for --names and --dirs.
    const bindir = join(root, "bin");
    mkdirSync(bindir, { recursive: true });
    writeFileSync(
      join(bindir, "slopenv"),
      `#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(CLI)} "$@"\n`,
      { mode: 0o755 },
    );

    // Ubuntu's global zshrc runs compinit before this one and hosted runners can
    // have intentionally group-writable system completion directories. Own the
    // setup here so the test never blocks on that unrelated security prompt.
    writeFileSync(join(zdotdir, ".zshenv"), "skip_global_compinit=1\n");

    writeFileSync(
      join(zdotdir, ".zshrc"),
      [
        `autoload -Uz compinit && compinit -u -d ${shellQuote(join(root, "zcompdump"))}`,
        `export SLOPENV_CONFIG=${shellQuote(rulesPath)}`,
        `export PATH=${shellQuote(bindir)}:$PATH`,
        `source ${shellQuote(completion)}`,
        `PROMPT='READY%% '`,
      ].join("\n"),
    );
  });

  /** Type `keys`, press TAB, and return what the terminal showed. */
  function pressTab(keys: string): string {
    const command = "zsh -i";
    const pty =
      process.platform === "darwin"
        ? `script -q /dev/null ${command}`
        : `script -qefc ${shellQuote(command)} /dev/null`;
    const script =
      `( sleep 1.5; printf '${keys}\\t'; sleep 2; printf '\\003'; sleep 0.4; printf 'exit\\r' )` +
      ` | ${pty} 2>&1`;
    const proc = Bun.spawnSync(["/bin/sh", "-c", script], {
      env: { ...process.env, ZDOTDIR: zdotdir },
      cwd: proj,
      stdout: "pipe",
      stderr: "pipe",
    });
    // Strip the escape sequences an interactive shell paints the line with.
    return proc.stdout
      .toString()
      .replace(/\r/g, "")
      // eslint-disable-next-line no-control-regex
      .replace(/\[[0-9;?]*[a-zA-Z]/g, "");
  }

  test("a partial command completes", async () => {
    expect(pressTab("slopenv se")).toContain("slopenv set");
  }, 30_000);

  test("`rm` offers the variables actually registered, not a hardcoded list", async () => {
    const output = pressTab("slopenv rm ");
    expect(output).toContain("FULL_NAME");
    expect(output).toContain("NODE_ENV");
    expect(output).toContain("PORT");
  }, 30_000);

  test("a partial variable name completes to the real one", async () => {
    expect(pressTab("slopenv rm PO")).toContain("slopenv rm PORT");
  }, 30_000);

  test("`hook` offers the shells it supports", async () => {
    const output = pressTab("slopenv hook ");
    expect(output).toContain("zsh");
    expect(output).toContain("bash");
  }, 30_000);
});
