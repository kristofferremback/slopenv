import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { run } from "../src/cli.ts";
import { accountFor } from "../src/secrets/index.ts";
import { loadRules } from "../src/rules.ts";
import { STATE_VAR } from "../src/state.ts";
import { cleanup, harness, tempDir, type Harness } from "./helpers.ts";
import { realpathSync } from "node:fs";

let root: string;
let rulesPath: string;
let work: string;
let apps: string;
let h: Harness;

beforeEach(() => {
  root = realpathSync(tempDir());
  rulesPath = join(root, "rules.json");
  work = join(root, "threa");
  apps = join(work, "apps");
  mkdirSync(apps, { recursive: true });
  h = harness({ rulesPath, cwd: work });
});

afterEach(() => cleanup(root));

function cli(...argv: string[]): number {
  h.reset();
  return run(argv, h.ctx);
}

describe("argument grammar", () => {
  test("NAME=VALUE sets the value, directory defaults to the current one", () => {
    expect(cli("set", "NODE_ENV=development")).toBe(0);
    const rules = loadRules(rulesPath).rules;
    expect(rules).toEqual([{ dir: work, name: "NODE_ENV", source: "plain", value: "development" }]);
  });

  test("a value may contain further equals signs", () => {
    // --yes because a URL with an embedded password trips the credential guard,
    // which is exactly what it is supposed to do.
    cli("set", "CONN=postgres://u:p@h/db?a=1&b=2", "--yes");
    expect(loadRules(rulesPath).rules[0]?.value).toBe("postgres://u:p@h/db?a=1&b=2");
  });

  test("NAME= sets an empty value", () => {
    cli("set", "EMPTY=");
    expect(loadRules(rulesPath).rules[0]?.value).toBe("");
  });

  test("with a bare NAME, the second positional is a directory", () => {
    cli("set", "TOKEN", "--value", "v", apps);
    expect(loadRules(rulesPath).rules[0]?.dir).toBe(apps);
  });

  test("the three-positional form from the brief still works", () => {
    cli("set", "TOKEN", "value", apps);
    expect(loadRules(rulesPath).rules[0]).toEqual({ dir: apps, name: "TOKEN", source: "plain", value: "value" });
  });

  test("--dir and --value override the positionals", () => {
    cli("set", "TOKEN=ignored", "--value", "used", "--dir", apps);
    expect(loadRules(rulesPath).rules[0]).toEqual({ dir: apps, name: "TOKEN", source: "plain", value: "used" });
  });

  test("a relative directory resolves against the current one", () => {
    cli("set", "TOKEN=v", "./apps");
    expect(loadRules(rulesPath).rules[0]?.dir).toBe(apps);
  });

  test("a directory that does not exist is refused rather than stored", () => {
    expect(() => cli("set", "TOKEN=v", join(root, "typo"))).toThrow(/does not exist/);
    expect(loadRules(rulesPath).rules).toEqual([]);
  });

  test("invalid and reserved names are refused", () => {
    expect(() => cli("set", "1BAD=v")).toThrow(/invalid variable name/);
    expect(() => cli("set", "has-dash=v")).toThrow(/invalid variable name/);
    expect(() => cli("set", "SLOPENV_STATE=v")).toThrow(/reserved/);
    expect(() => cli("set", "SLOPENV_CONFIG=v")).toThrow(/reserved/);
  });

  test("unknown flags and too many positionals are refused", () => {
    expect(() => cli("set", "A=1", "--nope")).toThrow(/unknown flag/);
    expect(() => cli("set", "A=1", work, "extra")).toThrow(/usage/);
  });

  test("a variable the shell depends on gets a warning but still works", () => {
    cli("set", "PATH=/custom/bin");
    expect(h.stderr()).toContain("heads up");
    expect(loadRules(rulesPath).rules).toHaveLength(1);
  });
});

describe("secrets", () => {
  test("the value goes to the keychain and never to the rules file", () => {
    cli("set-secret", "TOKEN=sk-ant-oat01-secret-value", work);
    expect(h.store.entries.get(accountFor(work, "TOKEN"))).toBe("sk-ant-oat01-secret-value");

    const raw = readFileSync(rulesPath, "utf8");
    expect(raw).not.toContain("sk-ant-oat01-secret-value");
    expect(loadRules(rulesPath).rules[0]).toEqual({ dir: work, name: "TOKEN", source: "keychain" });
  });

  test("the confirmation masks all but the last four characters", () => {
    cli("set-secret", "TOKEN=sk-ant-oat01-abcd-work", work);
    expect(h.stdout()).toContain("•••work");
    expect(h.stdout()).not.toContain("sk-ant-oat01");
  });

  test("an empty secret is refused", () => {
    expect(() => cli("set-secret", "TOKEN=", work)).toThrow(/empty value/);
  });

  test("rm deletes the rule and the keychain entry together", () => {
    cli("set-secret", "TOKEN=v", work);
    cli("rm", "TOKEN", work);
    expect(loadRules(rulesPath).rules).toEqual([]);
    expect(h.store.entries.has(accountFor(work, "TOKEN"))).toBe(false);
  });

  test("removing a rule that is not there says so", () => {
    expect(() => cli("rm", "NOPE", work)).toThrow(/no rule for NOPE/);
  });

  test("replacing a secret with a plain value cleans up the keychain entry", () => {
    cli("set-secret", "TOKEN=secret", work);
    cli("set", "TOKEN=not-secret", work, "--yes");
    expect(h.store.entries.has(accountFor(work, "TOKEN"))).toBe(false);
    expect(h.stderr()).toContain("deleted the keychain entry");
    expect(loadRules(rulesPath).rules[0]?.source).toBe("plain");
  });

  test("the same variable in two directories is two independent secrets", () => {
    cli("set-secret", "TOKEN=work-token", work);
    cli("set-secret", "TOKEN=apps-token", apps);
    expect(h.store.entries.get(accountFor(work, "TOKEN"))).toBe("work-token");
    expect(h.store.entries.get(accountFor(apps, "TOKEN"))).toBe("apps-token");
    expect(loadRules(rulesPath).rules).toHaveLength(2);
  });
});

describe("aliases", () => {
  test("an alias is stored and shown by list", () => {
    cli("set-secret", "TOKEN=abcd1234", work, "--alias", "Claude Code for work");
    expect(loadRules(rulesPath).rules[0]?.alias).toBe("Claude Code for work");
    expect(cli("list")).toBe(0);
    expect(h.stdout()).toContain("Claude Code for work");
    expect(h.stdout()).toContain("•••1234");
  });

  test("updating a value keeps the alias unless the flag is given", () => {
    cli("set-secret", "TOKEN=v1", work, "--alias", "original");
    cli("set-secret", "TOKEN=v2", work);
    expect(loadRules(rulesPath).rules[0]?.alias).toBe("original");

    cli("set-secret", "TOKEN=v3", work, "--alias", "renamed");
    expect(loadRules(rulesPath).rules[0]?.alias).toBe("renamed");
  });

  test("an empty alias clears it", () => {
    cli("set-secret", "TOKEN=v", work, "--alias", "temporary");
    cli("set-secret", "TOKEN=v", work, "--alias", "");
    expect(loadRules(rulesPath).rules[0]?.alias).toBeUndefined();
  });

  test("aliases distinguish two rules for the same variable", () => {
    cli("set-secret", "CLAUDE_CODE_OAUTH_TOKEN=aaaa-work", work, "--alias", "Claude Code for work");
    cli("set-secret", "CLAUDE_CODE_OAUTH_TOKEN=bbbb-pers", apps, "--alias", "Claude Code personal");
    cli("list");
    expect(h.stdout()).toContain("Claude Code for work");
    expect(h.stdout()).toContain("Claude Code personal");
  });
});

describe("list and status", () => {
  test("list on an empty config explains how to start", () => {
    expect(cli("list")).toBe(0);
    expect(h.stdout()).toContain("no rules yet");
  });

  test("--json never contains a secret value", () => {
    cli("set-secret", "TOKEN=sk-ant-oat01-secret", work);
    cli("set", "NODE_ENV=development", work);
    cli("list", "--json");
    expect(h.stdout()).not.toContain("sk-ant-oat01-secret");
    const parsed = JSON.parse(h.stdout()) as { rules: unknown[] };
    expect(parsed.rules).toHaveLength(2);
  });

  test("a rule whose keychain entry has vanished is shown as missing, not as an error", () => {
    cli("set-secret", "TOKEN=v", work);
    h.store.entries.clear();
    cli("list");
    expect(h.stdout()).toContain("<missing>");
  });

  test("status names the directory each value comes from", () => {
    cli("set-secret", "TOKEN=work-token", work);
    cli("set", "PORT=3000", apps);

    h.ctx.cwd = apps;
    cli("status");
    expect(h.stdout()).toContain("TOKEN");
    expect(h.stdout()).toContain("PORT");
    expect(h.stdout()).toContain(work);
  });

  test("status reports the deeper rule and flags the one it shadows", () => {
    cli("set", "TOKEN=from-work", work, "--yes");
    cli("set", "TOKEN=from-apps", apps, "--yes");

    h.ctx.cwd = apps;
    cli("status");
    expect(h.stdout()).toContain("from-apps");
    expect(h.stdout()).toContain("shadowed by a deeper rule");
  });

  test("status says nothing applies outside every rule directory", () => {
    cli("set", "TOKEN=v", work);
    h.ctx.cwd = root;
    cli("status");
    expect(h.stdout()).toContain("no rules apply here");
  });
});

describe("doctor", () => {
  test("reports a missing hook and a healthy rules file", () => {
    cli("set", "NODE_ENV=development", work);
    const code = cli("doctor");
    expect(h.stdout()).toContain("hook is not active in this shell");
    expect(h.stdout()).toContain("permissions are 0600");
    expect(code).toBe(1);
  });

  test("passes when the hook is active and everything resolves", () => {
    const hooked = harness({ rulesPath, cwd: work, env: { [STATE_VAR]: "x" } });
    run(["set-secret", "TOKEN=v"], hooked.ctx);
    expect(run(["doctor"], hooked.ctx)).toBe(0);
    expect(hooked.stdout()).toContain("no problems found");
  });

  test("flags a rule whose keychain entry is gone", () => {
    const hooked = harness({ rulesPath, cwd: work, env: { [STATE_VAR]: "x" } });
    run(["set-secret", "TOKEN=v"], hooked.ctx);
    hooked.store.entries.clear();
    expect(run(["doctor"], hooked.ctx)).toBe(1);
    expect(hooked.stdout()).toContain("no keychain entry");
  });

  test("flags a rule pointing at a directory that no longer exists", () => {
    const gone = join(root, "temporary");
    mkdirSync(gone);
    const hooked = harness({ rulesPath, cwd: gone, env: { [STATE_VAR]: "x" } });
    run(["set", "TOKEN=v"], hooked.ctx);
    cleanup(gone);
    expect(run(["doctor"], hooked.ctx)).toBe(1);
    expect(hooked.stdout()).toContain("directory no longer exists");
  });
});

describe("export", () => {
  test("emits statements plus the bookkeeping the hook needs", () => {
    cli("set", "NODE_ENV=development", work);
    cli("export", work);

    const lines = h.stdout().trim().split("\n");
    expect(lines).toContain("export NODE_ENV='development'");
    expect(lines.some((l) => l.startsWith(`export ${STATE_VAR}=`))).toBe(true);
    expect(lines.some((l) => l.startsWith("export SLOPENV_FP="))).toBe(true);
    expect(lines.some((l) => l.startsWith("export SLOPENV_DIRS="))).toBe(true);
    expect(lines.some((l) => l.startsWith("export SLOPENV_MATCH="))).toBe(true);
  });

  test("outside every rule it emits only bookkeeping", () => {
    cli("set", "NODE_ENV=development", work);
    cli("export", root);
    expect(h.stdout()).not.toContain("export NODE_ENV=");
  });

  test("a keychain miss warns on stderr and keeps stdout evaluable", () => {
    cli("set-secret", "TOKEN=v", work);
    h.store.entries.clear();
    cli("export", work);

    expect(h.stderr()).toContain("no keychain entry for TOKEN");
    expect(h.stdout()).not.toContain("TOKEN=");

    // The point of skipping the variable is that what remains is still a whole,
    // evaluable script — never a partial one.
    const proc = Bun.spawnSync(["/bin/zsh", "-f", "-c", `${h.stdout()}\nprintf 'ok:[%s]' "$TOKEN"`], {
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(proc.stderr.toString()).toBe("");
    expect(proc.exitCode).toBe(0);
    expect(proc.stdout.toString()).toBe("ok:[]");
  });

  test("a broken rules file exits non-zero with nothing on stdout", () => {
    writeFileSync(rulesPath, "{ not json");
    const broken = harness({ rulesPath, cwd: work });
    let code: number;
    try {
      code = run(["export", work], broken.ctx);
    } catch {
      code = 1; // main() turns this into a non-zero exit with a stderr message
    }
    expect(code).toBe(1);
    expect(broken.stdout()).toBe("");
  });

  test("SLOPENV_MATCH is exactly what the zsh guard rebuilds", () => {
    cli("set", "A=1", work);
    cli("set", "B=2", apps);
    cli("export", apps);

    const match = /export SLOPENV_MATCH='([\s\S]*?)'\n/.exec(h.stdout())?.[1];
    expect(match).toBe(`${work}\n${apps}\n`);
  });
});

describe("plain-text credential guard", () => {
  // Under `bun test` stdin is not a TTY, so these exercise the non-interactive
  // path: refuse rather than hang, because silence is not consent.
  test("refuses a credential-shaped value and explains both ways out", () => {
    expect(() => cli("set", "TOKEN=sk-ant-oat01-abcdefghijklmnopqrstuvwx", work)).toThrow(
      /refusing to store what looks like a credential/,
    );
    expect(h.stderr()).toContain("looks like an Anthropic OAuth token");
    expect(h.stderr()).toContain("slopenv set-secret TOKEN");
    expect(loadRules(rulesPath).rules).toEqual([]);
  });

  test("refuses on a secret-sounding name too", () => {
    expect(() => cli("set", "DATABASE_PASSWORD=correct-horse-battery", work)).toThrow(/refusing to store/);
    expect(loadRules(rulesPath).rules).toEqual([]);
  });

  test("--yes stores it anyway", () => {
    expect(cli("set", "TOKEN=sk-ant-oat01-abcdefghijklmnop", work, "--yes")).toBe(0);
    expect(loadRules(rulesPath).rules[0]?.value).toBe("sk-ant-oat01-abcdefghijklmnop");
  });

  test("-y, --force and -f are all accepted", () => {
    expect(cli("set", "A=ghp_AbCdEf1234567890abcdefghij", work, "-y")).toBe(0);
    expect(cli("set", "B=ghp_AbCdEf1234567890abcdefghij", work, "--force")).toBe(0);
    expect(cli("set", "C=ghp_AbCdEf1234567890abcdefghij", work, "-f")).toBe(0);
    expect(loadRules(rulesPath).rules).toHaveLength(3);
  });

  test("ordinary values are never questioned", () => {
    expect(cli("set", "NODE_ENV=development", work)).toBe(0);
    expect(cli("set", "PORT=3000", work)).toBe(0);
    expect(cli("set", "AWS_REGION=eu-north-1", work)).toBe(0);
    expect(h.stderr()).not.toContain("looks like");
    expect(h.stderr()).not.toContain("plain text");
  });

  test("set-secret never asks, since the value is going to the keychain", () => {
    expect(cli("set-secret", "TOKEN=sk-ant-oat01-abcdefghijklmnop", work)).toBe(0);
    expect(h.stderr()).not.toContain("looks like");
    expect(h.stderr()).not.toContain("Store it in plain text");
  });

  test("a value that only looks like a flag is still a value", () => {
    // `-5` must not be mistaken for a short flag now that short flags exist.
    expect(cli("set", "OFFSET", "--value", "-5", work)).toBe(0);
    expect(loadRules(rulesPath).rules[0]?.value).toBe("-5");
  });

  test("an unknown short flag is refused rather than ignored", () => {
    expect(() => cli("set", "A=1", "-q")).toThrow();
  });

  test("doctor flags a credential that got into the file another way", () => {
    // `edit` and hand-editing bypass the confirmation entirely.
    writeFileSync(
      rulesPath,
      JSON.stringify({
        version: 1,
        rules: [{ dir: work, name: "LEAKED", source: "plain", value: "ghp_AbCdEf1234567890abcdefghij" }],
      }),
    );
    const hooked = harness({ rulesPath, cwd: work, env: { [STATE_VAR]: "x" } });
    expect(run(["doctor"], hooked.ctx)).toBe(1);
    expect(hooked.stdout()).toContain("looks like a GitHub token, stored in plain text");
    expect(hooked.stdout()).toContain("slopenv set-secret LEAKED");
  });
});

describe("edit", () => {
  /** A scripted "editor" that rewrites the file it is handed. */
  function editorThatWrites(contents: string): string {
    const path = join(root, `editor-${Math.random().toString(36).slice(2)}.sh`);
    writeFileSync(path, `#!/bin/sh\ncat > "$1" <<'SLOPENV_EOF'\n${contents}\nSLOPENV_EOF\n`, { mode: 0o755 });
    return path;
  }

  test("saves what the editor wrote", () => {
    cli("set", "KEEP=1", work);
    const editor = editorThatWrites(
      JSON.stringify({ version: 1, rules: [{ dir: work, name: "EDITED", source: "plain", value: "by-editor" }] }),
    );
    const h2 = harness({ rulesPath, cwd: work, env: { EDITOR: editor } });
    expect(run(["edit"], h2.ctx)).toBe(0);
    expect(loadRules(rulesPath).rules).toEqual([{ dir: work, name: "EDITED", source: "plain", value: "by-editor" }]);
  });

  test("refuses to save a broken file and leaves the original alone", () => {
    cli("set", "KEEP=1", work);
    const before = readFileSync(rulesPath, "utf8");
    const editor = editorThatWrites("{ not json");
    const h2 = harness({ rulesPath, cwd: work, env: { EDITOR: editor } });
    expect(() => run(["edit"], h2.ctx)).toThrow(/rules file is invalid/);
    expect(readFileSync(rulesPath, "utf8")).toBe(before);
  });

  test("refuses to save a file that violates the schema", () => {
    cli("set", "KEEP=1", work);
    const before = readFileSync(rulesPath, "utf8");
    const editor = editorThatWrites(
      JSON.stringify({ version: 1, rules: [{ dir: work, name: "T", source: "keychain", value: "leaked" }] }),
    );
    const h2 = harness({ rulesPath, cwd: work, env: { EDITOR: editor } });
    expect(() => run(["edit"], h2.ctx)).toThrow(/must not be set for a keychain rule/);
    expect(readFileSync(rulesPath, "utf8")).toBe(before);
  });

  test("without $EDITOR it says so", () => {
    const h2 = harness({ rulesPath, cwd: work, env: {} });
    expect(() => run(["edit"], h2.ctx)).toThrow(/no \$EDITOR/);
  });
});

describe("cli surface", () => {
  test("no arguments prints help and exits non-zero", () => {
    expect(cli()).toBe(1);
    expect(h.stdout()).toContain("usage: slopenv");
  });

  test("an unknown command is rejected", () => {
    expect(cli("frobnicate")).toBe(1);
    expect(h.stderr()).toContain("unknown command");
  });

  test("--help and --version succeed", () => {
    expect(cli("--help")).toBe(0);
    expect(cli("--version")).toBe(0);
  });
});

describe("the hook not being wired up", () => {
  // The first failure everyone hits: binary installed, rule stored, nothing
  // injected, and no indication why. `doctor` alone was not enough, because
  // nobody runs `doctor` when they think things are working.
  test("set-secret says so straight after storing", () => {
    expect(cli("set-secret", "TOKEN=v", work)).toBe(0);
    expect(h.stdout()).toContain("TOKEN");
    expect(h.stderr()).toContain("the shell hook is not active here");
    expect(h.stderr()).toContain('eval "$(slopenv hook zsh)"');
  });

  test("set says so too", () => {
    expect(cli("set", "NODE_ENV=development", work)).toBe(0);
    expect(h.stderr()).toContain("the shell hook is not active here");
  });

  test("list says so, since a rule that is not being applied looks identical", () => {
    cli("set", "NODE_ENV=development", work);
    cli("list");
    expect(h.stdout()).toContain("NODE_ENV");
    expect(h.stderr()).toContain("the shell hook is not active here");
  });

  test("and stays quiet once the hook is in", () => {
    const hooked = harness({ rulesPath, cwd: work, env: { [STATE_VAR]: "x" } });
    expect(run(["set", "NODE_ENV=development", work], hooked.ctx)).toBe(0);
    expect(run(["list"], hooked.ctx)).toBe(0);
    expect(hooked.stderr()).toBe("");
  });

  test("the notice goes to stderr, never stdout", () => {
    // `list --json` is piped into other tools; a notice on stdout would corrupt it.
    cli("set", "NODE_ENV=development", work);
    cli("list", "--json");
    expect(() => JSON.parse(h.stdout())).not.toThrow();
  });
});
