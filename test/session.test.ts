import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { decodeState, STATE_VAR } from "../src/state.ts";
import { pauseScope } from "../src/commands/session.ts";
import type { Rule } from "../src/rules.ts";
import { applyStatements, cleanup, harness, runSync, splitStatements, tempDir, type Harness } from "./helpers.ts";

/**
 * `slopenv off` / `slopenv on`, driven through the real CLI with a fake shell
 * around it: statements come back on stdout and are applied to an environment
 * that is threaded into the next call, exactly as the hook does it.
 */

let root: string;
let rulesPath: string;
let work: string;
let apps: string;
let outside: string;

/** The environment of one terminal, shared by reference with the CLI context. */
class Shell {
  env: NodeJS.ProcessEnv = {};
  h: Harness;
  pwd: string;

  constructor(start: string, options: { stdoutIsTty?: boolean } = {}) {
    this.pwd = start;
    this.h = harness({ rulesPath, cwd: start, env: this.env, stdoutIsTty: options.stdoutIsTty });
  }

  private apply(code: number): void {
    // A non-zero exit means the hook evaluates nothing, so neither does this.
    if (code === 0) applyStatements(this.env as Record<string, string | undefined>, splitStatements(this.h.stdout()));
  }

  /** What the hook does on every cd. */
  cd(dir: string): number {
    this.pwd = dir;
    this.h.reset();
    const code = runSync(["export", dir], this.h.ctx);
    this.apply(code);
    return code;
  }

  /** What the hook's `slopenv` wrapper function does for `off` and `on`. */
  run(...argv: string[]): number {
    this.h.reset();
    const code = runSync([...argv, this.pwd], this.h.ctx);
    this.apply(code);
    return code;
  }

  get stderr(): string {
    return this.h.stderr();
  }

  get paused(): string | null {
    return decodeState(this.env[STATE_VAR]).paused;
  }
}

function writeRules(rules: readonly Rule[]): void {
  writeFileSync(rulesPath, `${JSON.stringify({ version: 1, rules }, null, 2)}\n`, { mode: 0o600 });
}

beforeEach(() => {
  root = realpathSync(tempDir());
  rulesPath = join(root, "rules.json");
  work = join(root, "threa");
  apps = join(work, "apps");
  outside = join(root, "elsewhere");
  mkdirSync(apps, { recursive: true });
  mkdirSync(outside, { recursive: true });

  writeRules([
    { dir: work, name: "TOKEN", source: "plain", value: "work-token" },
    { dir: work, name: "NODE_ENV", source: "plain", value: "development" },
    { dir: apps, name: "PORT", source: "plain", value: "3000" },
  ]);
});

afterEach(() => cleanup(root));

describe("off", () => {
  test("unloads what is loaded and says what it unloaded", () => {
    const shell = new Shell(work);
    shell.cd(work);
    expect(shell.env.TOKEN).toBe("work-token");

    expect(shell.run("off")).toBe(0);
    expect(shell.env.TOKEN).toBeUndefined();
    expect(shell.env.NODE_ENV).toBeUndefined();
    expect(shell.stderr).toContain("off in this shell — unloaded NODE_ENV, TOKEN");
    expect(shell.stderr).toContain("slopenv on");
  });

  test("gives back the value the shell had before slopenv, not an empty one", () => {
    const shell = new Shell(work);
    shell.env.TOKEN = "value-from-my-zshrc";
    shell.cd(work);
    expect(shell.env.TOKEN).toBe("work-token");

    shell.run("off");
    expect(shell.env.TOKEN).toBe("value-from-my-zshrc");

    shell.run("on");
    expect(shell.env.TOKEN).toBe("work-token");
    shell.cd(outside);
    expect(shell.env.TOKEN).toBe("value-from-my-zshrc");
  });

  test("stays off while you move around inside the directory", () => {
    const shell = new Shell(work);
    shell.cd(work);
    shell.run("off");

    shell.cd(apps);
    expect(shell.env.TOKEN).toBeUndefined();
    // A deeper rule must not sneak in through the side door either.
    expect(shell.env.PORT).toBeUndefined();

    shell.cd(join(apps, "web"));
    expect(shell.env.PORT).toBeUndefined();
    expect(shell.paused).toBe(work);
  });

  test("changes nothing outside this shell", () => {
    const first = new Shell(work);
    first.cd(work);
    first.run("off");

    const second = new Shell(work);
    second.cd(work);
    expect(second.env.TOKEN).toBe("work-token");
    expect(second.paused).toBeNull();

    // And nothing was written: the rules file is untouched by a pause.
    expect(JSON.parse(require("node:fs").readFileSync(rulesPath, "utf8")).rules).toHaveLength(3);
  });

  test("a second off says so and emits nothing", () => {
    const shell = new Shell(work);
    shell.cd(work);
    shell.run("off");

    const before = shell.env[STATE_VAR];
    expect(shell.run("off")).toBe(0);
    expect(shell.stderr).toContain("already off in this shell");
    expect(shell.h.stdout()).toBe("");
    expect(shell.env[STATE_VAR]).toBe(before);
  });

  test("refuses where there is nothing to turn off", () => {
    const shell = new Shell(work);
    shell.cd(work);
    shell.cd(outside);

    expect(shell.run("off")).toBe(0);
    expect(shell.stderr).toContain("no rules apply");
    expect(shell.paused).toBeNull();
  });
});

describe("the way back on", () => {
  test("leaving the directory ends the pause and says so", () => {
    const shell = new Shell(work);
    shell.cd(work);
    shell.run("off");

    shell.cd(outside);
    expect(shell.paused).toBeNull();
    expect(shell.stderr).toContain("env vars are on again");
    expect(shell.stderr).toContain("the pause ended when you left");

    // And coming back is ordinary again.
    shell.cd(work);
    expect(shell.env.TOKEN).toBe("work-token");
    expect(shell.stderr).not.toContain("pause");
  });

  test("the notice is said once, not on every prompt after", () => {
    const shell = new Shell(work);
    shell.cd(work);
    shell.run("off");

    shell.cd(outside);
    expect(shell.stderr).toContain("on again");

    shell.cd(outside);
    expect(shell.stderr).toBe("");
  });

  test("`on` loads again without leaving", () => {
    const shell = new Shell(work);
    shell.cd(work);
    shell.run("off");

    expect(shell.run("on")).toBe(0);
    expect(shell.env.TOKEN).toBe("work-token");
    expect(shell.env.NODE_ENV).toBe("development");
    expect(shell.paused).toBeNull();
    expect(shell.stderr).toContain("on again — NODE_ENV, TOKEN");
  });

  test("`on` when nothing is off says so and emits nothing", () => {
    const shell = new Shell(work);
    shell.cd(work);
    expect(shell.run("on")).toBe(0);
    expect(shell.stderr).toContain("not off in this shell");
    expect(shell.h.stdout()).toBe("");
  });

  test("a rule added while off does not load until the pause ends", () => {
    const shell = new Shell(work);
    shell.cd(work);
    shell.run("off");

    writeRules([
      { dir: work, name: "TOKEN", source: "plain", value: "work-token" },
      { dir: work, name: "LATE", source: "plain", value: "added-later" },
    ]);

    // A new rev normally re-resolves everything; a pause outranks that.
    shell.cd(apps);
    expect(shell.env.LATE).toBeUndefined();

    shell.run("on");
    expect(shell.env.LATE).toBe("added-later");
  });
});

describe("the hook can always see the pause boundary", () => {
  /**
   * SLOPENV_DIRS is the list the zsh hook watches to decide whether to call
   * slopenv at all. If the paused directory is not in it, leaving that directory
   * does not look like a change to the hook, and the pause outlives it silently.
   */
  function dirsFrom(shell: Shell): string[] {
    const state = shell.env.SLOPENV_DIRS ?? "";
    return state.split("\n").filter(Boolean);
  }

  test("the paused directory is in the watched list", () => {
    const shell = new Shell(work);
    shell.cd(work);
    shell.run("off");
    expect(dirsFrom(shell)).toContain(work);
  });

  test("and stays there even if its rule is removed from another terminal", () => {
    const shell = new Shell(work);
    shell.cd(work);
    shell.run("off");

    // Another terminal drops the rule the pause was pinned to.
    writeRules([{ dir: root, name: "WIDE", source: "plain", value: "1" }]);
    shell.cd(work);
    expect(dirsFrom(shell)).toContain(work);
    expect(shell.env.WIDE).toBeUndefined();

    // Leaving still ends it, and the surviving ancestor rule loads.
    shell.cd(outside);
    expect(shell.paused).toBeNull();
    expect(shell.env.WIDE).toBe("1");
    expect(dirsFrom(shell)).not.toContain(work);
  });
});

describe("where the pause is pinned", () => {
  test("to the rule directory, not to $PWD, so subdirectories are inside it", () => {
    const shell = new Shell(work);
    shell.cd(join(apps, "web"));
    shell.run("off");
    // Deepest rule covering apps/web is `apps`, so leaving `apps` ends it — and
    // moving up to `work`, which is not inside it, counts as leaving.
    expect(shell.paused).toBe(apps);

    shell.cd(work);
    expect(shell.paused).toBeNull();
    expect(shell.env.TOKEN).toBe("work-token");
  });

  test("pauseScope picks the deepest rule covering the directory", () => {
    const rules: Rule[] = [
      { dir: "/dev", name: "A", source: "plain", value: "1" },
      { dir: "/dev/threa", name: "B", source: "plain", value: "2" },
    ];
    expect(pauseScope(rules, "/dev/threa/apps")).toBe("/dev/threa");
    expect(pauseScope(rules, "/dev/other")).toBe("/dev");
    expect(pauseScope(rules, "/tmp")).toBeNull();
    // A sibling sharing a prefix is not inside it.
    expect(pauseScope(rules, "/dev/threa-2")).toBe("/dev");
  });
});

describe("when nothing will evaluate the output", () => {
  test("without the hook, it explains the hook instead of printing statements", () => {
    const shell = new Shell(work);
    expect(shell.run("off")).toBe(1);
    expect(shell.h.stdout()).toBe("");
    expect(shell.stderr).toContain("the shell hook is not active here");
  });

  test("on a terminal, it explains the missing shell function", () => {
    const shell = new Shell(work, { stdoutIsTty: true });
    // The hook is loaded (state is present) but predates the wrapper function.
    shell.env[STATE_VAR] = "x";

    expect(shell.run("off")).toBe(1);
    expect(shell.h.stdout()).toBe("");
    expect(shell.stderr).toContain("has to run through the shell function");
    expect(shell.stderr).toContain(`eval "$(slopenv hook zsh)"`);

    expect(shell.run("on")).toBe(1);
    expect(shell.stderr).toContain("`on` changes this shell");
  });

  test("the bash hook is named when that is the shell in use", () => {
    const shell = new Shell(work, { stdoutIsTty: true });
    shell.env[STATE_VAR] = "x";
    shell.env.SHELL = "/bin/bash";
    shell.run("off");
    expect(shell.stderr).toContain(`eval "$(slopenv hook bash)"`);
  });
});

describe("status and doctor say when it is off", () => {
  test("status shows the pause and where it is pinned", () => {
    const shell = new Shell(work);
    shell.cd(work);
    shell.run("off");

    shell.h.reset();
    runSync(["status", work], shell.h.ctx);
    expect(shell.h.stdout()).toContain("paused:     yes");
    expect(shell.h.stdout()).toContain("slopenv on");
  });

  test("doctor notes it without calling it a problem", () => {
    const shell = new Shell(work);
    shell.cd(work);
    shell.run("off");

    shell.h.reset();
    runSync(["doctor"], shell.h.ctx);
    // `note`, not `FAIL`: it is a state you asked for, not something to fix.
    expect(shell.h.stdout()).toContain("note  off in this shell since");
  });
});
