import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { legacyRulesFilePath, rulesFilePath, slopenvHome } from "../src/paths.ts";
import { cleanup, harness, runAsync, tempDir } from "./helpers.ts";

const dirs: string[] = [];
function scratch(): string {
  const dir = tempDir();
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) cleanup(dir);
});

describe("where the rules file lives", () => {
  test("~/.slopenv/rules.json by default", async () => {
    expect(rulesFilePath({ HOME: "/Users/kris" })).toBe("/Users/kris/.slopenv/rules.json");
    expect(slopenvHome({ HOME: "/Users/kris" })).toBe("/Users/kris/.slopenv");
  });

  test("$XDG_CONFIG_HOME no longer moves it — the home directory is the home directory", async () => {
    expect(rulesFilePath({ HOME: "/Users/kris", XDG_CONFIG_HOME: "/Users/kris/.config" })).toBe(
      "/Users/kris/.slopenv/rules.json",
    );
  });

  test("$SLOPENV_CONFIG overrides everything", async () => {
    expect(rulesFilePath({ HOME: "/Users/kris", SLOPENV_CONFIG: "/tmp/other.json" })).toBe("/tmp/other.json");
  });

  test("a relative $SLOPENV_CONFIG is made absolute", async () => {
    expect(rulesFilePath({ HOME: "/Users/kris", SLOPENV_CONFIG: "rules.json" })).toBe(join(process.cwd(), "rules.json"));
  });

  test("the old location is still computable, for reporting only", async () => {
    expect(legacyRulesFilePath({ HOME: "/Users/kris" })).toBe("/Users/kris/.config/slopenv/rules.json");
    expect(legacyRulesFilePath({ HOME: "/Users/kris", XDG_CONFIG_HOME: "/xdg" })).toBe("/xdg/slopenv/rules.json");
  });
});

describe("rules left behind at the old location", () => {
  /** A fake home with a populated ~/.config/slopenv and no ~/.slopenv. */
  function homeWithLegacyRules(): { home: string; env: NodeJS.ProcessEnv } {
    const home = scratch();
    const legacy = join(home, ".config", "slopenv");
    mkdirSync(legacy, { recursive: true });
    writeFileSync(
      join(legacy, "rules.json"),
      JSON.stringify({ version: 1, rules: [{ dir: "/a", name: "OLD", source: "plain", value: "1" }] }),
    );
    return { home, env: { HOME: home } };
  }

  test("are pointed out, with the command to move them", async () => {
    const { home, env } = homeWithLegacyRules();
    const h = harness({ rulesPath: rulesFilePath(env), cwd: home, env });

    await runAsync(["list"], h.ctx);

    expect(h.stderr()).toContain("which is the old location");
    expect(h.stderr()).toContain(join(home, ".config", "slopenv", "rules.json"));
    expect(h.stderr()).toContain(join(home, ".slopenv", "rules.json"));
    expect(h.stderr()).toContain("mv ");
  });

  test("are not moved — slopenv says what to do, it does not do it", async () => {
    const { home, env } = homeWithLegacyRules();
    const h = harness({ rulesPath: rulesFilePath(env), cwd: home, env });

    await runAsync(["list"], h.ctx);

    // Nothing created, nothing removed, and the listing is honestly empty.
    expect(Bun.file(join(home, ".slopenv", "rules.json")).size).toBe(0);
    expect(Bun.file(join(home, ".config", "slopenv", "rules.json")).size).toBeGreaterThan(0);
    expect(h.stdout()).toContain("no rules yet");
  });

  test("the notice stops once the new file exists", async () => {
    const { home, env } = homeWithLegacyRules();
    const newPath = rulesFilePath(env);
    mkdirSync(join(home, ".slopenv"), { recursive: true });
    writeFileSync(newPath, JSON.stringify({ version: 1, rules: [] }));

    const h = harness({ rulesPath: newPath, cwd: home, env });
    await runAsync(["list"], h.ctx);
    expect(h.stderr()).toBe("");
  });

  test("no notice when $SLOPENV_CONFIG is doing the deciding", async () => {
    const { home } = homeWithLegacyRules();
    const explicit = join(home, "explicit.json");
    const env: NodeJS.ProcessEnv = { HOME: home, SLOPENV_CONFIG: explicit };

    const h = harness({ rulesPath: explicit, cwd: home, env });
    await runAsync(["list"], h.ctx);
    expect(h.stderr()).toBe("");
  });

  test("`export` never checks — it runs on every cd and must stay silent", async () => {
    const { home, env } = homeWithLegacyRules();
    const h = harness({ rulesPath: rulesFilePath(env), cwd: home, env });

    await runAsync(["export", home], h.ctx);
    expect(h.stderr()).toBe("");
  });
});
