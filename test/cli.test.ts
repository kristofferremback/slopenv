import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { accountFor } from "../src/secrets/index.ts";
import { loadRules } from "../src/rules.ts";
import { STATE_VAR } from "../src/state.ts";
import { cleanup, harness, runAsync, runSync, tempDir, type Harness } from "./helpers.ts";
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

async function cli(...argv: string[]): Promise<number> {
  h.reset();
  return await runAsync(argv, h.ctx);
}

describe("argument grammar", () => {
  test("NAME=VALUE sets the value, directory defaults to the current one", async () => {
    expect(await cli("set", "NODE_ENV=development")).toBe(0);
    const rules = loadRules(rulesPath).rules;
    expect(rules).toEqual([{ dir: work, name: "NODE_ENV", source: "plain", value: "development" }]);
  });

  test("a value may contain further equals signs", async () => {
    // --yes because a URL with an embedded password trips the credential guard,
    // which is exactly what it is supposed to do.
    await cli("set", "CONN=postgres://u:p@h/db?a=1&b=2", "--yes");
    expect(loadRules(rulesPath).rules[0]?.value).toBe("postgres://u:p@h/db?a=1&b=2");
  });

  test("NAME= sets an empty value", async () => {
    await cli("set", "EMPTY=");
    expect(loadRules(rulesPath).rules[0]?.value).toBe("");
  });

  test("with a bare NAME, the second positional is a directory", async () => {
    await cli("set", "TOKEN", "--value", "v", apps);
    expect(loadRules(rulesPath).rules[0]?.dir).toBe(apps);
  });

  test("the three-positional form from the brief still works", async () => {
    await cli("set", "TOKEN", "value", apps);
    expect(loadRules(rulesPath).rules[0]).toEqual({ dir: apps, name: "TOKEN", source: "plain", value: "value" });
  });

  test("--dir and --value override the positionals", async () => {
    await cli("set", "TOKEN=ignored", "--value", "used", "--dir", apps);
    expect(loadRules(rulesPath).rules[0]).toEqual({ dir: apps, name: "TOKEN", source: "plain", value: "used" });
  });

  test("a relative directory resolves against the current one", async () => {
    await cli("set", "TOKEN=v", "./apps");
    expect(loadRules(rulesPath).rules[0]?.dir).toBe(apps);
  });

  test("a directory that does not exist is refused rather than stored", async () => {
    await expect(cli("set", "TOKEN=v", join(root, "typo"))).rejects.toThrow(/does not exist/);
    expect(loadRules(rulesPath).rules).toEqual([]);
  });

  test("invalid and reserved names are refused", async () => {
    await expect(cli("set", "1BAD=v")).rejects.toThrow(/invalid variable name/);
    await expect(cli("set", "has-dash=v")).rejects.toThrow(/invalid variable name/);
    await expect(cli("set", "SLOPENV_STATE=v")).rejects.toThrow(/reserved/);
    await expect(cli("set", "SLOPENV_CONFIG=v")).rejects.toThrow(/reserved/);
  });

  test("unknown flags and too many positionals are refused", async () => {
    await expect(cli("set", "A=1", "--nope")).rejects.toThrow(/unknown flag/);
    await expect(cli("set", "A=1", work, "extra")).rejects.toThrow(/usage/);
  });

  test("a variable the shell depends on gets a warning but still works", async () => {
    await cli("set", "PATH=/custom/bin");
    expect(h.stderr()).toContain("heads up");
    expect(loadRules(rulesPath).rules).toHaveLength(1);
  });
});

describe("secrets", () => {
  test("the value goes to the keychain and never to the rules file", async () => {
    await cli("set", "--secret", "TOKEN=sk-ant-oat01-secret-value", work);
    expect(h.store.entries.get(accountFor(work, "TOKEN"))).toBe("sk-ant-oat01-secret-value");

    const raw = readFileSync(rulesPath, "utf8");
    expect(raw).not.toContain("sk-ant-oat01-secret-value");
    expect(loadRules(rulesPath).rules[0]).toEqual({ dir: work, name: "TOKEN", source: "keychain" });
  });

  test("the confirmation masks all but the last four characters", async () => {
    await cli("set", "--secret", "TOKEN=sk-ant-oat01-abcd-work", work);
    expect(h.stdout()).toContain("•••work");
    expect(h.stdout()).not.toContain("sk-ant-oat01");
  });

  test("an empty secret is refused", async () => {
    await expect(cli("set", "--secret", "TOKEN=", work)).rejects.toThrow(/empty value/);
  });

  test("rm deletes the rule and the keychain entry together", async () => {
    await cli("set", "--secret", "TOKEN=v", work);
    await cli("rm", "TOKEN", work);
    expect(loadRules(rulesPath).rules).toEqual([]);
    expect(h.store.entries.has(accountFor(work, "TOKEN"))).toBe(false);
  });

  test("removing a rule that is not there says so", async () => {
    await expect(cli("rm", "NOPE", work)).rejects.toThrow(/no rule for NOPE/);
  });

  test("replacing a secret with a plain value cleans up the keychain entry", async () => {
    await cli("set", "--secret", "TOKEN=secret", work);
    await cli("set", "TOKEN=not-secret", work, "--yes");
    expect(h.store.entries.has(accountFor(work, "TOKEN"))).toBe(false);
    expect(h.stderr()).toContain("deleted the secret-store entry");
    expect(loadRules(rulesPath).rules[0]?.source).toBe("plain");
  });

  test("the same variable in two directories is two independent secrets", async () => {
    await cli("set", "--secret", "TOKEN=work-token", work);
    await cli("set", "--secret", "TOKEN=apps-token", apps);
    expect(h.store.entries.get(accountFor(work, "TOKEN"))).toBe("work-token");
    expect(h.store.entries.get(accountFor(apps, "TOKEN"))).toBe("apps-token");
    expect(loadRules(rulesPath).rules).toHaveLength(2);
  });
});

describe("aliases", () => {
  test("an alias is stored and shown by list", async () => {
    await cli("set", "--secret", "TOKEN=abcd1234", work, "--alias", "Claude Code for work");
    expect(loadRules(rulesPath).rules[0]?.alias).toBe("Claude Code for work");
    expect(await cli("list")).toBe(0);
    expect(h.stdout()).toContain("Claude Code for work");
    expect(h.stdout()).toContain("•••1234");
  });

  test("updating a value keeps the alias unless the flag is given", async () => {
    await cli("set", "--secret", "TOKEN=v1", work, "--alias", "original");
    await cli("set", "--secret", "TOKEN=v2", work);
    expect(loadRules(rulesPath).rules[0]?.alias).toBe("original");

    await cli("set", "--secret", "TOKEN=v3", work, "--alias", "renamed");
    expect(loadRules(rulesPath).rules[0]?.alias).toBe("renamed");
  });

  test("an empty alias clears it", async () => {
    await cli("set", "--secret", "TOKEN=v", work, "--alias", "temporary");
    await cli("set", "--secret", "TOKEN=v", work, "--alias", "");
    expect(loadRules(rulesPath).rules[0]?.alias).toBeUndefined();
  });

  test("aliases distinguish two rules for the same variable", async () => {
    await cli("set", "--secret", "CLAUDE_CODE_OAUTH_TOKEN=aaaa-work", work, "--alias", "Claude Code for work");
    await cli("set", "--secret", "CLAUDE_CODE_OAUTH_TOKEN=bbbb-pers", apps, "--alias", "Claude Code personal");
    await cli("list");
    expect(h.stdout()).toContain("Claude Code for work");
    expect(h.stdout()).toContain("Claude Code personal");
  });
});

describe("list and status", () => {
  test("list on an empty config explains how to start", async () => {
    expect(await cli("list")).toBe(0);
    expect(h.stdout()).toContain("no rules yet");
  });

  test("--json never contains a secret value", async () => {
    await cli("set", "--secret", "TOKEN=sk-ant-oat01-secret", work);
    await cli("set", "NODE_ENV=development", work);
    await cli("list", "--json");
    expect(h.stdout()).not.toContain("sk-ant-oat01-secret");
    const parsed = JSON.parse(h.stdout()) as { rules: unknown[] };
    expect(parsed.rules).toHaveLength(2);
  });

  test("a rule whose keychain entry has vanished is shown as missing, not as an error", async () => {
    await cli("set", "--secret", "TOKEN=v", work);
    h.store.entries.clear();
    await cli("list");
    expect(h.stdout()).toContain("<missing>");
  });

  test("status names the directory each value comes from", async () => {
    await cli("set", "--secret", "TOKEN=work-token", work);
    await cli("set", "PORT=3000", apps);

    h.ctx.cwd = apps;
    await cli("status");
    expect(h.stdout()).toContain("TOKEN");
    expect(h.stdout()).toContain("PORT");
    expect(h.stdout()).toContain(work);
  });

  test("status reports the deeper rule and flags the one it shadows", async () => {
    await cli("set", "TOKEN=from-work", work, "--yes");
    await cli("set", "TOKEN=from-apps", apps, "--yes");

    h.ctx.cwd = apps;
    await cli("status");
    expect(h.stdout()).toContain("from-apps");
    expect(h.stdout()).toContain("shadowed by a deeper rule");
  });

  test("status says nothing applies outside every rule directory", async () => {
    await cli("set", "TOKEN=v", work);
    h.ctx.cwd = root;
    await cli("status");
    expect(h.stdout()).toContain("no rules apply here");
  });
});

describe("doctor", () => {
  test("reports a missing hook and a healthy rules file", async () => {
    await cli("set", "NODE_ENV=development", work);
    const code = await cli("doctor");
    expect(h.stdout()).toContain("hook is not active in this shell");
    expect(h.stdout()).toContain("permissions are 0600");
    expect(code).toBe(1);
  });

  test("passes when the hook is active and everything resolves", async () => {
    const hooked = harness({ rulesPath, cwd: work, env: { [STATE_VAR]: "x" } });
    await runAsync(["set", "--secret", "TOKEN=v"], hooked.ctx);
    expect(await runAsync(["doctor"], hooked.ctx)).toBe(0);
    expect(hooked.stdout()).toContain("no problems found");
  });

  test("flags a rule whose keychain entry is gone", async () => {
    const hooked = harness({ rulesPath, cwd: work, env: { [STATE_VAR]: "x" } });
    await runAsync(["set", "--secret", "TOKEN=v"], hooked.ctx);
    hooked.store.entries.clear();
    expect(await runAsync(["doctor"], hooked.ctx)).toBe(1);
    expect(hooked.stdout()).toContain("no secret-store entry");
  });

  test("flags a rule pointing at a directory that no longer exists", async () => {
    const gone = join(root, "temporary");
    mkdirSync(gone);
    const hooked = harness({ rulesPath, cwd: gone, env: { [STATE_VAR]: "x" } });
    await runAsync(["set", "TOKEN=v"], hooked.ctx);
    cleanup(gone);
    expect(await runAsync(["doctor"], hooked.ctx)).toBe(1);
    expect(hooked.stdout()).toContain("directory no longer exists");
  });
});

describe("export", () => {
  test("emits statements plus the bookkeeping the hook needs", async () => {
    await cli("set", "NODE_ENV=development", work);
    await cli("export", work);

    const lines = h.stdout().trim().split("\n");
    expect(lines).toContain("export NODE_ENV='development'");
    expect(lines.some((l) => l.startsWith(`export ${STATE_VAR}=`))).toBe(true);
    expect(lines.some((l) => l.startsWith("export SLOPENV_FP="))).toBe(true);
    expect(lines.some((l) => l.startsWith("export SLOPENV_DIRS="))).toBe(true);
    expect(lines.some((l) => l.startsWith("export SLOPENV_MATCH="))).toBe(true);
  });

  test("outside every rule it emits only bookkeeping", async () => {
    await cli("set", "NODE_ENV=development", work);
    await cli("export", root);
    expect(h.stdout()).not.toContain("export NODE_ENV=");
  });

  test("a keychain miss warns on stderr and keeps stdout evaluable", async () => {
    await cli("set", "--secret", "TOKEN=v", work);
    h.store.entries.clear();
    await cli("export", work);

    expect(h.stderr()).toContain("no secret-store entry for TOKEN");
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

  test("a broken rules file exits non-zero with nothing on stdout", async () => {
    writeFileSync(rulesPath, "{ not json");
    const broken = harness({ rulesPath, cwd: work });
    let code: number;
    try {
      code = await runAsync(["export", work], broken.ctx);
    } catch {
      code = 1; // main() turns this into a non-zero exit with a stderr message
    }
    expect(code).toBe(1);
    expect(broken.stdout()).toBe("");
  });

  test("SLOPENV_MATCH is exactly what the zsh guard rebuilds", async () => {
    await cli("set", "A=1", work);
    await cli("set", "B=2", apps);
    await cli("export", apps);

    const match = /export SLOPENV_MATCH='([\s\S]*?)'\n/.exec(h.stdout())?.[1];
    expect(match).toBe(`${work}\n${apps}\n`);
  });
});

describe("plain-text credential guard", () => {
  // Under `bun test` stdin is not a TTY, so these exercise the non-interactive
  // path: refuse rather than hang, because silence is not consent.
  test("refuses a credential-shaped value and explains both ways out", async () => {
    await expect(cli("set", "TOKEN=sk-ant-oat01-abcdefghijklmnopqrstuvwx", work)).rejects.toThrow(
      /refusing to store what looks like a credential/,
    );
    expect(h.stderr()).toContain("looks like an Anthropic OAuth token");
    expect(h.stderr()).toContain("slopenv set --secret TOKEN");
    expect(loadRules(rulesPath).rules).toEqual([]);
  });

  test("refuses on a secret-sounding name too", async () => {
    await expect(cli("set", "DATABASE_PASSWORD=correct-horse-battery", work)).rejects.toThrow(/refusing to store/);
    expect(loadRules(rulesPath).rules).toEqual([]);
  });

  test("--yes stores it anyway", async () => {
    expect(await cli("set", "TOKEN=sk-ant-oat01-abcdefghijklmnop", work, "--yes")).toBe(0);
    expect(loadRules(rulesPath).rules[0]?.value).toBe("sk-ant-oat01-abcdefghijklmnop");
  });

  test("-y, --force and -f are all accepted", async () => {
    expect(await cli("set", "A=ghp_AbCdEf1234567890abcdefghij", work, "-y")).toBe(0);
    expect(await cli("set", "B=ghp_AbCdEf1234567890abcdefghij", work, "--force")).toBe(0);
    expect(await cli("set", "C=ghp_AbCdEf1234567890abcdefghij", work, "-f")).toBe(0);
    expect(loadRules(rulesPath).rules).toHaveLength(3);
  });

  test("ordinary values are never questioned", async () => {
    expect(await cli("set", "NODE_ENV=development", work)).toBe(0);
    expect(await cli("set", "PORT=3000", work)).toBe(0);
    expect(await cli("set", "AWS_REGION=eu-north-1", work)).toBe(0);
    expect(h.stderr()).not.toContain("looks like");
    expect(h.stderr()).not.toContain("plain text");
  });

  test("--secret never asks, since the value is going to the keychain", async () => {
    expect(await cli("set", "--secret", "TOKEN=sk-ant-oat01-abcdefghijklmnop", work)).toBe(0);
    expect(h.stderr()).not.toContain("looks like");
    expect(h.stderr()).not.toContain("Store it in plain text");
  });

  test("a value that only looks like a flag is still a value", async () => {
    // `-5` must not be mistaken for a short flag now that short flags exist.
    expect(await cli("set", "OFFSET", "--value", "-5", work)).toBe(0);
    expect(loadRules(rulesPath).rules[0]?.value).toBe("-5");
  });

  test("an unknown short flag is refused rather than ignored", async () => {
    await expect(cli("set", "A=1", "-q")).rejects.toThrow();
  });

  test("doctor flags a credential that got into the file another way", async () => {
    // `edit` and hand-editing bypass the confirmation entirely.
    writeFileSync(
      rulesPath,
      JSON.stringify({
        version: 1,
        rules: [{ dir: work, name: "LEAKED", source: "plain", value: "ghp_AbCdEf1234567890abcdefghij" }],
      }),
    );
    const hooked = harness({ rulesPath, cwd: work, env: { [STATE_VAR]: "x" } });
    expect(await runAsync(["doctor"], hooked.ctx)).toBe(1);
    expect(hooked.stdout()).toContain("looks like a GitHub token, stored in plain text");
    expect(hooked.stdout()).toContain("slopenv set --secret LEAKED");
  });
});

describe("edit", () => {
  /** A scripted "editor" that rewrites the file it is handed. */
  function editorThatWrites(contents: string): string {
    const path = join(root, `editor-${Math.random().toString(36).slice(2)}.sh`);
    writeFileSync(path, `#!/bin/sh\ncat > "$1" <<'SLOPENV_EOF'\n${contents}\nSLOPENV_EOF\n`, { mode: 0o755 });
    return path;
  }

  test("saves what the editor wrote", async () => {
    await cli("set", "KEEP=1", work);
    const editor = editorThatWrites(
      JSON.stringify({ version: 1, rules: [{ dir: work, name: "EDITED", source: "plain", value: "by-editor" }] }),
    );
    const h2 = harness({ rulesPath, cwd: work, env: { EDITOR: editor } });
    expect(runSync(["edit"], h2.ctx)).toBe(0);
    expect(loadRules(rulesPath).rules).toEqual([{ dir: work, name: "EDITED", source: "plain", value: "by-editor" }]);
  });

  test("refuses to save a broken file and leaves the original alone", async () => {
    await cli("set", "KEEP=1", work);
    const before = readFileSync(rulesPath, "utf8");
    const editor = editorThatWrites("{ not json");
    const h2 = harness({ rulesPath, cwd: work, env: { EDITOR: editor } });
    expect(() => runSync(["edit"], h2.ctx)).toThrow(/rules file is invalid/);
    expect(readFileSync(rulesPath, "utf8")).toBe(before);
  });

  test("refuses to save a file that violates the schema", async () => {
    await cli("set", "KEEP=1", work);
    const before = readFileSync(rulesPath, "utf8");
    const editor = editorThatWrites(
      JSON.stringify({ version: 1, rules: [{ dir: work, name: "T", source: "keychain", value: "leaked" }] }),
    );
    const h2 = harness({ rulesPath, cwd: work, env: { EDITOR: editor } });
    expect(() => runSync(["edit"], h2.ctx)).toThrow(/must not be set for a keychain rule/);
    expect(readFileSync(rulesPath, "utf8")).toBe(before);
  });

  test("without $EDITOR it says so", async () => {
    const h2 = harness({ rulesPath, cwd: work, env: {} });
    expect(() => runSync(["edit"], h2.ctx)).toThrow(/no \$EDITOR/);
  });
});

describe("cli surface", () => {
  test("no arguments prints help and exits non-zero", async () => {
    expect(await cli()).toBe(1);
    expect(h.stdout()).toContain("usage: slopenv");
  });

  test("an unknown command is rejected", async () => {
    expect(await cli("frobnicate")).toBe(1);
    expect(h.stderr()).toContain("unknown command");
  });

  test("--help and --version succeed", async () => {
    expect(await cli("--help")).toBe(0);
    expect(await cli("--version")).toBe(0);
  });
});

describe("the hook not being wired up", () => {
  // The first failure everyone hits: binary installed, rule stored, nothing
  // injected, and no indication why. `doctor` alone was not enough, because
  // nobody runs `doctor` when they think things are working.
  test("--secret says so straight after storing", async () => {
    expect(await cli("set", "--secret", "TOKEN=v", work)).toBe(0);
    expect(h.stdout()).toContain("TOKEN");
    expect(h.stderr()).toContain("the shell hook is not active here");
    expect(h.stderr()).toContain('eval "$(slopenv hook zsh)"');
  });

  test("set says so too", async () => {
    expect(await cli("set", "NODE_ENV=development", work)).toBe(0);
    expect(h.stderr()).toContain("the shell hook is not active here");
  });

  test("list says so, since a rule that is not being applied looks identical", async () => {
    await cli("set", "NODE_ENV=development", work);
    await cli("list");
    expect(h.stdout()).toContain("NODE_ENV");
    expect(h.stderr()).toContain("the shell hook is not active here");
  });

  test("and stays quiet once the hook is in", async () => {
    const hooked = harness({ rulesPath, cwd: work, env: { [STATE_VAR]: "x" } });
    expect(await runAsync(["set", "NODE_ENV=development", work], hooked.ctx)).toBe(0);
    expect(await runAsync(["list"], hooked.ctx)).toBe(0);
    expect(hooked.stderr()).toBe("");
  });

  test("the notice goes to stderr, never stdout", async () => {
    // `list --json` is piped into other tools; a notice on stdout would corrupt it.
    await cli("set", "NODE_ENV=development", work);
    await cli("list", "--json");
    expect(() => JSON.parse(h.stdout())).not.toThrow();
  });
});

describe("one command, two places to put a value", () => {
  test("--plain is the default spelled out, and changes nothing", async () => {
    await cli("set", "NODE_ENV=development", "--plain");
    expect(loadRules(rulesPath).rules[0]).toEqual({ dir: work, name: "NODE_ENV", source: "plain", value: "development" });
    expect(h.store.get(work, "NODE_ENV")).toBeNull();
  });

  test("--secret puts it in the keychain and nothing in the file", async () => {
    await cli("set", "--secret", "TOKEN=sk-value");
    const rule = loadRules(rulesPath).rules[0];
    expect(rule?.source).toBe("keychain");
    expect(rule?.value).toBeUndefined();
    expect(h.store.get(work, "TOKEN")).toBe("sk-value");
  });

  test("the flag can go anywhere the parser sees it", async () => {
    await cli("set", "TOKEN=sk-value", apps, "--secret");
    expect(loadRules(rulesPath).rules[0]?.dir).toBe(apps);
    expect(h.store.get(apps, "TOKEN")).toBe("sk-value");
  });

  test("--plain and --secret together are refused", async () => {
    await expect(cli("set", "FOO=bar", "--plain", "--secret")).rejects.toThrow(/opposites/);
  });

  test("switching a rule from one to the other leaves nothing behind", async () => {
    await cli("set", "--secret", "TOKEN=in-keychain");
    expect(h.store.get(work, "TOKEN")).toBe("in-keychain");

    await cli("set", "TOKEN=now-plain", "--yes");
    expect(h.store.get(work, "TOKEN")).toBeNull();
    expect(loadRules(rulesPath).rules[0]?.value).toBe("now-plain");

    await cli("set", "--secret", "TOKEN=back-in-keychain");
    expect(loadRules(rulesPath).rules[0]?.value).toBeUndefined();
    expect(h.store.get(work, "TOKEN")).toBe("back-in-keychain");
  });

  test("`set-secret` says what replaced it rather than `unknown command`", async () => {
    const code = await cli("set-secret", "TOKEN=x");
    expect(code).toBe(1);
    expect(h.stderr()).toContain("`set-secret` is now `set --secret`");
    // And it really is gone, not quietly aliased: nothing was written.
    expect(loadRules(rulesPath).rules).toEqual([]);
    expect(h.store.get(work, "TOKEN")).toBeNull();
  });

  test("an actually unknown command still gets the plain message", async () => {
    expect(await cli("frobnicate")).toBe(1);
    expect(h.stderr()).toContain("unknown command");
    expect(h.stderr()).not.toContain("is now");
  });

  test("the credential guard points at the new spelling", async () => {
    await expect(cli("set", "GITHUB_TOKEN=ghp_aaaaaaaaaaaaaaaaaaaa")).rejects.toThrow(/set --secret/);
    expect(h.stderr()).toContain("slopenv set --secret GITHUB_TOKEN");
  });
});
