import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { realpathSync } from "node:fs";
import { shellQuote } from "../src/shell.ts";
import { cleanup, tempDir } from "./helpers.ts";

/**
 * End-to-end through a real zsh: generate the hook, source it, cd around, and read
 * the environment back. Everything else in the suite tests slopenv's idea of what
 * should happen; this tests what a shell actually does.
 *
 * Only plain rules are used so the real keychain is never touched.
 */

const CLI = join(import.meta.dir, "..", "src", "cli.ts");

let root: string;
let rulesPath: string;
let workDir: string;
let appsDir: string;
let siblingDir: string;
let outsideDir: string;
let hookPath: string;
let counterPath: string;

/** Every slopenv invocation appends a line here, so the fast path is measurable. */
function spawnCount(): number {
  try {
    return readFileSync(counterPath, "utf8").split("\n").filter(Boolean).length;
  } catch {
    return 0;
  }
}

function slopenv(args: string[]): void {
  // These fixtures are deliberately plain rules (so the real keychain is never
  // touched), and some are named TOKEN — which trips the credential guard on
  // purpose. --yes is the documented override; `rm` has nothing to confirm.
  const full = args[0] === "set" ? [...args, "--yes"] : args;
  const proc = Bun.spawnSync(["bun", CLI, ...full], {
    env: { ...process.env, SLOPENV_CONFIG: rulesPath },
    stdout: "pipe",
    stderr: "pipe",
  });
  if (proc.exitCode !== 0) throw new Error(`slopenv ${args.join(" ")} failed: ${proc.stderr.toString()}`);
}

/** Run a zsh script with the hook sourced, and return both streams. */
function zshRun(script: string): { stdout: string; stderr: string } {
  const proc = Bun.spawnSync(["/bin/zsh", "-f", "-c", `source ${shellQuote(hookPath)}\n${script}`], {
    env: { ...process.env, SLOPENV_CONFIG: rulesPath, HOME: root },
    cwd: outsideDir,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (proc.exitCode !== 0) {
    throw new Error(`zsh exited ${proc.exitCode}\nstdout: ${proc.stdout.toString()}\nstderr: ${proc.stderr.toString()}`);
  }
  return { stdout: proc.stdout.toString(), stderr: proc.stderr.toString() };
}

/** The common case: only what the script printed. */
function zsh(script: string): string {
  return zshRun(script).stdout;
}

beforeAll(() => {
  root = realpathSync(tempDir());
  rulesPath = join(root, "rules.json");
  workDir = join(root, "dev", "threa");
  appsDir = join(workDir, "apps");
  siblingDir = join(root, "dev", "threa-2");
  outsideDir = join(root, "dev");
  counterPath = join(root, "spawns.log");

  for (const dir of [appsDir, siblingDir, outsideDir]) mkdirSync(dir, { recursive: true });

  slopenv(["set", "TOKEN=work-token", workDir, "--alias", "Claude Code for work"]);
  slopenv(["set", "TOKEN=sibling-token", siblingDir]);
  slopenv(["set", "PORT=3000", appsDir]);
  slopenv(["set", "NODE_ENV=development", workDir]);

  // A wrapper that counts invocations, substituted into the generated hook in
  // place of the real binary so the fast path can be observed rather than assumed.
  const wrapper = join(root, "slopenv-counting-wrapper");
  writeFileSync(
    wrapper,
    `#!/bin/sh\necho run >> ${shellQuote(counterPath)}\nexec ${shellQuote(process.execPath)} ${shellQuote(CLI)} "$@"\n`,
    { mode: 0o755 },
  );
  chmodSync(wrapper, 0o755);

  const generated = Bun.spawnSync(["bun", CLI, "hook", "zsh"], {
    env: { ...process.env, SLOPENV_CONFIG: rulesPath },
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(generated.exitCode).toBe(0);

  const realInvocation = `${shellQuote(process.execPath)} ${shellQuote(CLI)}`;
  const hookText = generated.stdout.toString().split(realInvocation).join(shellQuote(wrapper));
  expect(hookText).toContain(shellQuote(wrapper));

  hookPath = join(root, "hook.zsh");
  writeFileSync(hookPath, hookText);
});

afterAll(() => cleanup(root));

describe("zsh hook", () => {
  test("injects on entry and ejects on leave", () => {
    const output = zsh(`
      unset NODE_ENV
      print "outside:[$TOKEN]"
      cd ${shellQuote(workDir)}
      print "work:[$TOKEN][$NODE_ENV]"
      cd ${shellQuote(outsideDir)}
      print "back:[$TOKEN][$NODE_ENV]"
    `);
    expect(output).toContain("outside:[]");
    expect(output).toContain("work:[work-token][development]");
    expect(output).toContain("back:[][]");
  });

  test("a subdirectory inherits the parent rule and adds its own", () => {
    const output = zsh(`
      cd ${shellQuote(appsDir)}
      print "apps:[$TOKEN][$PORT]"
      cd ${shellQuote(workDir)}
      print "work:[$TOKEN][$PORT]"
    `);
    expect(output).toContain("apps:[work-token][3000]");
    expect(output).toContain("work:[work-token][]");
  });

  test("a sibling directory sharing a prefix gets its own value, not the neighbour's", () => {
    const output = zsh(`
      cd ${shellQuote(workDir)}
      print "work:[$TOKEN]"
      cd ${shellQuote(siblingDir)}
      print "sibling:[$TOKEN]"
    `);
    expect(output).toContain("work:[work-token]");
    expect(output).toContain("sibling:[sibling-token]");
  });

  test("a value the shell already had is restored on leave", () => {
    const output = zsh(`
      export TOKEN='from-my-zshrc'
      cd ${shellQuote(workDir)}
      print "inside:[$TOKEN]"
      cd ${shellQuote(appsDir)}
      print "deeper:[$TOKEN]"
      cd ${shellQuote(outsideDir)}
      print "restored:[$TOKEN]"
    `);
    expect(output).toContain("inside:[work-token]");
    expect(output).toContain("deeper:[work-token]");
    expect(output).toContain("restored:[from-my-zshrc]");
  });

  test("entering through a symlink matches the real directory", () => {
    const link = join(root, "symlinked-threa");
    Bun.spawnSync(["/bin/ln", "-sfn", workDir, link]);
    const output = zsh(`
      cd ${shellQuote(link)}
      print "via-link:[$TOKEN]"
      cd ${shellQuote(join(link, "apps"))}
      print "via-link-deep:[$PORT]"
    `);
    expect(output).toContain("via-link:[work-token]");
    expect(output).toContain("via-link-deep:[3000]");
  });

  test("a value full of shell metacharacters survives the round trip", () => {
    const nasty = `it's "$(touch ${root}/pwned)" \`x\` \\ | ; & > <`;
    slopenv(["set", "NASTY", "--value", nasty, "--dir", workDir]);
    const output = zsh(`
      cd ${shellQuote(workDir)}
      printf 'nasty:[%s]\\n' "$NASTY"
    `);
    expect(output).toContain(`nasty:[${nasty}]`);
    // The `$(touch ...)` inside the value must never have run.
    expect(existsSync(join(root, "pwned"))).toBe(false);
  });
});

describe("off and on, in a live shell", () => {
  test("off unloads here, and leaving the directory loads again", () => {
    const { stdout, stderr } = zshRun(`
      unset NODE_ENV
      cd ${shellQuote(workDir)}
      print "in:[$TOKEN][$NODE_ENV]"
      slopenv off
      print "off:[$TOKEN][$NODE_ENV]"
      cd ${shellQuote(appsDir)}
      print "deeper:[$TOKEN][$PORT]"
      cd ${shellQuote(outsideDir)}
      print "outside:[$TOKEN]"
      cd ${shellQuote(workDir)}
      print "back:[$TOKEN][$NODE_ENV]"
    `);

    expect(stdout).toContain("in:[work-token][development]");
    expect(stdout).toContain("off:[][]");
    // Still off further in, including a rule that only applies down there.
    expect(stdout).toContain("deeper:[][]");
    expect(stdout).toContain("outside:[]");
    expect(stdout).toContain("back:[work-token][development]");

    expect(stderr).toMatch(/off in this shell — unloaded .*NODE_ENV.*TOKEN/);
    expect(stderr).toContain("env vars are on again");
  });

  test("on loads again without leaving", () => {
    const { stdout, stderr } = zshRun(`
      cd ${shellQuote(workDir)}
      slopenv off
      print "off:[$TOKEN]"
      slopenv on
      print "on:[$TOKEN]"
    `);
    expect(stdout).toContain("off:[]");
    expect(stdout).toContain("on:[work-token]");
    expect(stderr).toMatch(/on again — .*NODE_ENV.*TOKEN/);
  });

  test("a value the shell already had comes back while off, not an empty one", () => {
    const stdout = zsh(`
      export TOKEN='from-my-zshrc'
      cd ${shellQuote(workDir)}
      print "in:[$TOKEN]"
      slopenv off
      print "off:[$TOKEN]"
      slopenv on
      print "on:[$TOKEN]"
    `);
    expect(stdout).toContain("in:[work-token]");
    expect(stdout).toContain("off:[from-my-zshrc]");
    expect(stdout).toContain("on:[work-token]");
  });

  test("the wrapper passes every other command straight through", () => {
    const stdout = zsh(`
      cd ${shellQuote(workDir)}
      slopenv list --names
      slopenv --version
    `);
    expect(stdout).toContain("NODE_ENV");
    expect(stdout).toContain("TOKEN");
    expect(stdout).toMatch(/\d+\.\d+\.\d+/);
  });

  test("a pause outlives its own rule being removed elsewhere, and still ends on the way out", () => {
    // The hook only calls slopenv when the rules file or the set of covering rule
    // directories changes. Removing the paused directory's rule takes it out of
    // that set, so leaving would stop looking like a change — and the pause would
    // silently follow you around. `_slopenv_hook` below stands in for the prompt
    // that consumes the rules-file change, so the `cd` has nothing left to notice.
    const scratch = join(root, "dev", "scratch");
    mkdirSync(scratch, { recursive: true });
    slopenv(["set", "SCRATCH_VAR=here", scratch]);

    const { stdout, stderr } = zshRun(`
      cd ${shellQuote(scratch)}
      print "in:[$SCRATCH_VAR]"
      slopenv off
      slopenv rm SCRATCH_VAR ${shellQuote(scratch)} >/dev/null
      _slopenv_hook
      print "rule-gone:[$SCRATCH_VAR]"
      cd ${shellQuote(outsideDir)}
      print "out:[$SCRATCH_VAR]"
    `);

    expect(stdout).toContain("in:[here]");
    expect(stdout).toContain("rule-gone:[]");
    expect(stdout).toContain("out:[]");
    expect(stderr).toContain("env vars are on again");
  });

  test("the pause does not leak into another shell", () => {
    const stdout = zsh(`
      cd ${shellQuote(workDir)}
      slopenv off
      print "here:[$TOKEN]"
      env -u SLOPENV_STATE -u SLOPENV_FP -u SLOPENV_MATCH /bin/zsh -f -c 'source ${hookPath} >/dev/null 2>&1; cd ${workDir}; print "fresh:[$TOKEN]"'
    `);
    expect(stdout).toContain("here:[]");
    expect(stdout).toContain("fresh:[work-token]");
  });
});

describe("the fast path actually skips work", () => {
  test("moving within one rule's scope does not spawn slopenv", () => {
    writeFileSync(counterPath, "");
    zsh(`
      cd ${shellQuote(workDir)}
      cd ${shellQuote(appsDir)}
      cd ${shellQuote(appsDir)}
      cd ${shellQuote(workDir)}
    `);
    // Startup, entering workDir, entering appsDir, and back to workDir. The
    // repeated `cd` into appsDir changes nothing, so it must not spawn.
    expect(spawnCount()).toBe(4);

    writeFileSync(counterPath, "");
    zsh(`
      cd ${shellQuote(appsDir)}
      mkdir -p deep/deeper/deepest
      cd deep; cd deeper; cd deepest; cd ..; cd ..
    `);
    // Startup plus entering appsDir; the five cds below it change nothing.
    expect(spawnCount()).toBe(2);
  });

  test("a rules change made elsewhere is picked up without a cd", () => {
    const output = zsh(`
      cd ${shellQuote(workDir)}
      print "before:[$LATE]"
      ${shellQuote(process.execPath)} ${shellQuote(CLI)} set LATE=added-later ${shellQuote(workDir)} >/dev/null
      _slopenv_hook
      print "after:[$LATE]"
    `);
    expect(output).toContain("before:[]");
    expect(output).toContain("after:[added-later]");
    slopenv(["rm", "LATE", workDir]);
  });
});

describe("hook generation", () => {
  test("the simple hook is emitted on request and has no fast path", () => {
    const proc = Bun.spawnSync(["bun", CLI, "hook", "zsh", "--simple"], {
      env: { ...process.env, SLOPENV_CONFIG: rulesPath },
      stdout: "pipe",
    });
    const text = proc.stdout.toString();
    expect(text).toContain("add-zsh-hook chpwd _slopenv_hook");
    expect(text).not.toContain("zstat");
  });

  test("bash gets a hook, fish gets a clear refusal", () => {
    const bash = Bun.spawnSync(["bun", CLI, "hook", "bash"], { stdout: "pipe" });
    expect(bash.exitCode).toBe(0);
    expect(bash.stdout.toString()).toContain("PROMPT_COMMAND");

    const fish = Bun.spawnSync(["bun", CLI, "hook", "fish"], { stdout: "pipe", stderr: "pipe" });
    expect(fish.exitCode).toBe(1);
    expect(fish.stderr.toString()).toContain("no fish hook yet");
  });

  test("the generated bash hook is syntactically valid", () => {
    const bash = Bun.spawnSync(["bun", CLI, "hook", "bash"], { stdout: "pipe" });
    const check = Bun.spawnSync(["/bin/bash", "-n"], {
      stdin: new TextEncoder().encode(bash.stdout.toString()),
      stderr: "pipe",
    });
    expect(check.stderr.toString()).toBe("");
    expect(check.exitCode).toBe(0);
  });
});
