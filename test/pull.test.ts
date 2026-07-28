import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { computePlan } from "../src/engine.ts";
import { describeAge, formatDuration, parseDuration } from "../src/duration.ts";
import { loadRules, parseRules, type Rule } from "../src/rules.ts";
import { accountFor } from "../src/secrets/index.ts";
import { MemorySecretStore } from "../src/secrets/memory.ts";
import { emptyState } from "../src/state.ts";
import { engineForRef, trimOneNewline } from "../src/vault/index.ts";
import { cleanup, harness, runSync, tempDir, type Harness } from "./helpers.ts";

/**
 * `slopenv pull` against a stand-in `op` on `$PATH`.
 *
 * A fake binary rather than a mocked function, deliberately: what is worth testing
 * here is the part that talks to another program — the argument list, the exit
 * code, the trailing newline, what happens to stderr — and none of that is
 * exercised by replacing the call.
 */

let root: string;
let rulesPath: string;
let work: string;
let apps: string;
let binDir: string;
let callLog: string;
let h: Harness;

/** Every fake-`op` invocation appends its argv here, one per line. */
function calls(): string[] {
  try {
    return readFileSync(callLog, "utf8").split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * Write a fake `op` onto the test PATH. `body` is shell, and runs with the real
 * argv, so a test can answer, fail, or hang exactly as `op` would.
 */
function fakeOp(body: string): void {
  const path = join(binDir, "op");
  writeFileSync(path, `#!/bin/sh\nprintf '%s\\n' "op $*" >> ${JSON.stringify(callLog)}\n${body}\n`, { mode: 0o755 });
  chmodSync(path, 0o755);
}

function cli(...argv: string[]): number {
  h.reset();
  return runSync(argv, h.ctx);
}

beforeEach(() => {
  root = realpathSync(tempDir());
  rulesPath = join(root, "rules.json");
  work = join(root, "threa");
  apps = join(work, "apps");
  binDir = join(root, "bin");
  callLog = join(root, "op-calls.log");
  mkdirSync(apps, { recursive: true });
  mkdirSync(binDir, { recursive: true });

  // Only the fake binary is reachable, so a stray call to a real `op` — if the
  // machine running the suite happens to have one — cannot make a test pass.
  h = harness({ rulesPath, cwd: work, env: { PATH: binDir } });
  fakeOp(`printf 'sk-from-1password\\n'`);
});

afterEach(() => cleanup(root));

describe("pull", () => {
  test("fetches, caches in the keychain, and records the reference", () => {
    expect(cli("pull", "TOKEN", "--ref", "op://Work/Claude Code/credential")).toBe(0);

    // The value went to the keychain; the reference went to the rules file.
    expect(h.store.get(work, "TOKEN")).toBe("sk-from-1password");
    const rules = loadRules(rulesPath).rules;
    expect(rules).toHaveLength(1);
    const rule = rules[0] as Rule;
    expect(rule.source).toBe("vault");
    expect(rule.engine).toBe("1password");
    expect(rule.ref).toBe("op://Work/Claude Code/credential");
    expect(rule.value).toBeUndefined();
    expect(Number.isNaN(Date.parse(rule.fetched as string))).toBe(false);

    // The secret is never printed in full.
    expect(h.stdout()).toContain("•••word");
    expect(h.stdout()).not.toContain("sk-from-1password");
  });

  test("passes the reference as one argument, with no shell in between", () => {
    // A reference full of shell metacharacters is the whole point of argv.
    const ref = `op://Work/It's "risky"; $(touch ${root}/pwned)/credential`;
    cli("pull", "TOKEN", "--ref", ref);

    expect(calls()).toEqual([`op read ${ref}`]);
    expect(() => readFileSync(join(root, "pwned"))).toThrow();
  });

  test("the rules file holds a reference, never the secret", () => {
    cli("pull", "TOKEN", "--ref", "op://Work/Claude/credential");
    const text = readFileSync(rulesPath, "utf8");
    expect(text).toContain("op://Work/Claude/credential");
    expect(text).not.toContain("sk-from-1password");
  });

  test("trims the newline op prints, and nothing else", () => {
    fakeOp(`printf 'value-with-trailing-space \\n'`);
    cli("pull", "TOKEN", "--ref", "op://a/b/c");
    expect(h.store.get(work, "TOKEN")).toBe("value-with-trailing-space ");
  });

  test("a directory argument works the same way it does for set", () => {
    cli("pull", "TOKEN", apps, "--ref", "op://a/b/c");
    expect((loadRules(rulesPath).rules[0] as Rule).dir).toBe(apps);
    expect(h.store.get(apps, "TOKEN")).toBe("sk-from-1password");
  });

  test("re-pulling needs no reference, and keeps the alias and the window", () => {
    cli("pull", "TOKEN", "--ref", "op://a/b/c", "--alias", "Work token", "--ttl", "30d");
    const first = loadRules(rulesPath).rules[0] as Rule;
    expect(first.alias).toBe("Work token");
    expect(first.ttl).toBe(2_592_000);

    fakeOp(`printf 'rotated\\n'`);
    expect(cli("pull", "TOKEN")).toBe(0);

    const second = loadRules(rulesPath).rules[0] as Rule;
    expect(second.ref).toBe("op://a/b/c");
    expect(second.alias).toBe("Work token");
    expect(second.ttl).toBe(2_592_000);
    expect(h.store.get(work, "TOKEN")).toBe("rotated");
    expect(h.stdout()).toContain("pulled from");
  });

  test("says when a value came back unchanged", () => {
    cli("pull", "TOKEN", "--ref", "op://a/b/c");
    expect(cli("pull", "TOKEN")).toBe(0);
    expect(h.stdout()).toContain("unchanged");
  });

  test("refuses to pull a rule that has no reference, and says how to give it one", () => {
    cli("set", "PORT=3000");
    expect(() => cli("pull", "PORT")).toThrow(/no secret reference[\s\S]*plain rule[\s\S]*--ref/);
  });
});

describe("when op fails", () => {
  test("nothing is written — no rule, no keychain entry", () => {
    fakeOp(`echo '[ERROR] item "Nope" doesn.t exist' >&2; exit 1`);
    expect(() => cli("pull", "TOKEN", "--ref", "op://Work/Nope/credential")).toThrow(/could not read/);

    expect(h.store.get(work, "TOKEN")).toBeNull();
    expect(loadRules(rulesPath).rules).toEqual([]);
  });

  test("op's own message is shown, with advice when it is one we recognise", () => {
    fakeOp(`echo '[ERROR] you are not currently signed in' >&2; exit 1`);
    expect(() => cli("pull", "TOKEN", "--ref", "op://a/b/c")).toThrow(/op signin/);
  });

  test("an empty value is refused rather than cached", () => {
    fakeOp(`printf '\\n'`);
    expect(() => cli("pull", "TOKEN", "--ref", "op://a/b/c")).toThrow(/empty value/);
    expect(h.store.get(work, "TOKEN")).toBeNull();
  });

  test("a missing op says how to install it, rather than reporting ENOENT", () => {
    h = harness({ rulesPath, cwd: work, env: { PATH: join(root, "empty") } });
    expect(() => cli("pull", "TOKEN", "--ref", "op://a/b/c")).toThrow(/brew install 1password-cli/);
  });

  test("a reference slopenv has no engine for is refused before anything runs", () => {
    expect(() => cli("pull", "TOKEN", "--ref", "bw://item/field")).toThrow(/no vault engine/);
    expect(() => cli("pull", "TOKEN", "--ref", "just-a-string")).toThrow(/is not a secret reference/);
    expect(calls()).toEqual([]);
  });

  test("--engine that disagrees with the reference is refused", () => {
    expect(() => cli("pull", "TOKEN", "--ref", "op://a/b/c", "--engine", "bitwarden")).toThrow(/unknown engine/);
  });
});

describe("pull --all", () => {
  beforeEach(() => {
    cli("pull", "TOKEN", "--ref", "op://Work/One/credential");
    cli("pull", "OTHER", apps, "--ref", "op://Work/Two/credential");
    cli("set", "PORT=3000");
  });

  test("re-fetches every reference and leaves other rules alone", () => {
    fakeOp(`printf 'refreshed\\n'`);
    expect(cli("pull", "--all")).toBe(0);

    expect(h.store.get(work, "TOKEN")).toBe("refreshed");
    expect(h.store.get(apps, "OTHER")).toBe("refreshed");
    expect(h.stdout()).toContain("2 of 2 pulled");

    // The plain rule was not touched, and no vault call was made for it.
    expect(loadRules(rulesPath).rules.find((r) => r.name === "PORT")?.value).toBe("3000");
    expect(calls().filter((c) => c.includes("PORT"))).toEqual([]);
  });

  test("one failure does not stop the rest, and the exit code says so", () => {
    fakeOp(`case "$2" in *One*) echo 'nope' >&2; exit 1;; *) printf 'refreshed\\n';; esac`);
    expect(cli("pull", "--all")).toBe(1);

    expect(h.store.get(apps, "OTHER")).toBe("refreshed");
    expect(h.stdout()).toContain("1 of 2 pulled");
    expect(h.stdout()).toContain("slopenv pull TOKEN");
    expect(h.stderr()).toContain("nope");
  });

  test("a failed pull does not get a fresh timestamp", () => {
    const before = loadRules(rulesPath).rules.find((r) => r.name === "TOKEN")?.fetched;
    fakeOp(`echo 'nope' >&2; exit 1`);
    cli("pull", "--all");
    expect(loadRules(rulesPath).rules.find((r) => r.name === "TOKEN")?.fetched).toBe(before as string);
  });

  test("writes the rules file once, not once per secret", () => {
    fakeOp(`printf 'refreshed\\n'`);
    const before = readFileSync(rulesPath, "utf8");
    cli("pull", "--all");
    // Every write changes the fingerprint and makes live shells re-resolve, so
    // batching is not just tidiness.
    const after = loadRules(rulesPath).rules.filter((r) => r.source === "vault");
    expect(after).toHaveLength(2);
    expect(before).not.toBe(readFileSync(rulesPath, "utf8"));
  });

  test("says what to do when there is nothing to pull", () => {
    h = harness({ rulesPath: join(root, "empty.json"), cwd: work, env: { PATH: binDir } });
    expect(cli("pull", "--all")).toBe(0);
    expect(h.stdout()).toContain("no vault references yet");
  });
});

describe("the hot path never talks to the vault", () => {
  test("export reads the cached value and spawns nothing", () => {
    cli("pull", "TOKEN", "--ref", "op://Work/One/credential");
    writeFileSync(callLog, "");

    expect(cli("export", work)).toBe(0);
    expect(h.stdout()).toContain(`export TOKEN='sk-from-1password'`);
    expect(calls()).toEqual([]);
  });

  test("a reference with no cached value yet points at pull, not set-secret", () => {
    const rule: Rule = { dir: work, name: "TOKEN", source: "vault", ref: "op://a/b/c", engine: "1password" };
    const plan = computePlan({
      rules: [rule],
      pwd: work,
      prevState: emptyState(),
      env: {},
      store: new MemorySecretStore(),
      rev: "r1",
    });
    expect(plan.statements).toEqual([]);
    expect(plan.warnings[0]).toContain("slopenv pull TOKEN");
  });

  test("an overdue value is still exported, with a word about it", () => {
    const store = new MemorySecretStore({ [accountFor(work, "TOKEN")]: "cached" });
    const rule: Rule = {
      dir: work,
      name: "TOKEN",
      source: "vault",
      ref: "op://a/b/c",
      engine: "1password",
      fetched: new Date("2026-01-01T00:00:00Z").toISOString(),
      ttl: 30 * 86_400,
    };
    const plan = computePlan({
      rules: [rule],
      pwd: work,
      prevState: emptyState(),
      env: {},
      store,
      rev: "r1",
      now: Date.parse("2026-03-01T00:00:00Z"),
    });

    // Exported anyway: blocking a prompt on a network call would be worse than an
    // old token, and so would leaving the variable unset.
    expect(plan.statements).toEqual([`export TOKEN='cached'`]);
    expect(plan.warnings[0]).toContain("refresh window has passed");
    expect(plan.warnings[0]).toContain("59 days ago");
  });

  test("no ttl means no nagging", () => {
    const store = new MemorySecretStore({ [accountFor(work, "TOKEN")]: "cached" });
    const rule: Rule = {
      dir: work,
      name: "TOKEN",
      source: "vault",
      ref: "op://a/b/c",
      engine: "1password",
      fetched: new Date("2020-01-01T00:00:00Z").toISOString(),
    };
    const plan = computePlan({ rules: [rule], pwd: work, prevState: emptyState(), env: {}, store, rev: "r1" });
    expect(plan.warnings).toEqual([]);
  });
});

describe("vault rules alongside everything else", () => {
  test("a link can borrow from a reference, and follows a re-pull", () => {
    const web = join(root, "web");
    mkdirSync(web, { recursive: true });

    cli("pull", "TOKEN", "--ref", "op://Work/One/credential");
    expect(cli("link", "TOKEN", "--from", work, web)).toBe(0);

    // One value, one keychain entry, two directories — the link resolves through
    // the vault rule to the same cached secret.
    expect(cli("export", web)).toBe(0);
    expect(h.stdout()).toContain(`export TOKEN='sk-from-1password'`);

    fakeOp(`printf 'rotated\\n'`);
    cli("pull", "TOKEN");
    expect(cli("export", web)).toBe(0);
    expect(h.stdout()).toContain(`export TOKEN='rotated'`);
  });

  test("rm takes the cached value with it", () => {
    cli("pull", "TOKEN", "--ref", "op://a/b/c");
    expect(cli("rm", "TOKEN")).toBe(0);
    expect(h.store.get(work, "TOKEN")).toBeNull();
    expect(h.stdout()).toContain("its cached value");
  });

  test("replacing a reference with a plain value clears the cache and says so", () => {
    cli("pull", "TOKEN", "--ref", "op://a/b/c");
    expect(cli("set", "TOKEN=plain-now", "--yes")).toBe(0);
    expect(h.store.get(work, "TOKEN")).toBeNull();
    expect(h.stderr()).toContain("used to pull op://a/b/c");
  });

  test("set-secret over a reference detaches it", () => {
    cli("pull", "TOKEN", "--ref", "op://a/b/c");
    expect(cli("set-secret", "TOKEN=typed-by-hand")).toBe(0);
    expect(loadRules(rulesPath).rules[0]?.source).toBe("keychain");
    expect(loadRules(rulesPath).rules[0]?.ref).toBeUndefined();
    expect(h.store.get(work, "TOKEN")).toBe("typed-by-hand");
  });

  test("list shows the reference, and doctor reports the cache", () => {
    cli("pull", "TOKEN", "--ref", "op://Work/One/credential", "--alias", "Work token");

    cli("list");
    expect(h.stdout()).toContain("FROM");
    expect(h.stdout()).toContain("op://Work/One/credential");
    expect(h.stdout()).toContain("Work token");

    cli("doctor");
    expect(h.stdout()).toContain("vault references (1)");
    expect(h.stdout()).toContain("pulled just now");
  });

  test("doctor calls a missing cache a failure, since that is what breaks the hot path", () => {
    cli("pull", "TOKEN", "--ref", "op://a/b/c");
    h.store.remove(work, "TOKEN");
    expect(cli("doctor")).toBe(1);
    expect(h.stdout()).toContain("nothing cached yet");
  });
});

describe("the rules file", () => {
  test("only claims version 3 once it actually contains a reference", () => {
    const withLink = parseRules(
      JSON.stringify({
        version: 2,
        rules: [
          { dir: "/a", name: "V", source: "plain", value: "1" },
          { dir: "/b", name: "V", source: "link", target: "/a" },
        ],
      }),
    );
    expect(withLink.version).toBe(2);

    const withRef = parseRules(
      JSON.stringify({
        version: 3,
        rules: [{ dir: "/a", name: "V", source: "vault", ref: "op://a/b/c", engine: "1password" }],
      }),
    );
    expect(withRef.version).toBe(3);
  });

  test("refuses the malformed shapes a vault rule can take", () => {
    const cases: [unknown, RegExp][] = [
      [{ dir: "/a", name: "V", source: "vault", engine: "1password" }, /ref must be a non-empty string/],
      [{ dir: "/a", name: "V", source: "vault", ref: "op://a/b/c" }, /engine must be a non-empty string/],
      [{ dir: "/a", name: "V", source: "vault", ref: "op://a/b/c", engine: "1password", value: "x" }, /value must not be set/],
      [{ dir: "/a", name: "V", source: "vault", ref: "op://a/b/c", engine: "1password", fetched: "soon" }, /ISO-8601/],
      [{ dir: "/a", name: "V", source: "vault", ref: "op://a/b/c", engine: "1password", ttl: -1 }, /positive whole number/],
      [{ dir: "/a", name: "V", source: "plain", value: "x", ref: "op://a/b/c" }, /ref must not be set/],
      [{ dir: "/a", name: "V", source: "keychain", engine: "1password" }, /engine must not be set/],
    ];
    for (const [rule, pattern] of cases) {
      expect(() => parseRules(JSON.stringify({ version: 3, rules: [rule] }))).toThrow(pattern);
    }
  });
});

describe("small parts", () => {
  test("references map to engines by scheme", () => {
    expect(engineForRef("op://a/b/c").id).toBe("1password");
    expect(() => engineForRef("op:/a/b")).toThrow(/not a secret reference/);
  });

  test("only the newline the CLI added is removed", () => {
    expect(trimOneNewline("value\n")).toBe("value");
    expect(trimOneNewline("value\r\n")).toBe("value");
    expect(trimOneNewline("value\n\n")).toBe("value\n");
    expect(trimOneNewline("value")).toBe("value");
    expect(trimOneNewline("va\nlue")).toBe("va\nlue");
  });

  test("durations round-trip", () => {
    expect(parseDuration("30d")).toBe(2_592_000);
    expect(parseDuration("12h")).toBe(43_200);
    expect(parseDuration("90")).toBe(90);
    expect(formatDuration(2_592_000)).toBe("30d");
    expect(formatDuration(90)).toBe("90s");
    expect(() => parseDuration("soon")).toThrow(/invalid duration/);
    expect(() => parseDuration("0d")).toThrow(/greater than zero/);
  });

  test("ages read the way a person would say them", () => {
    const now = Date.parse("2026-07-28T12:00:00Z");
    expect(describeAge("2026-07-28T11:59:30Z", now)).toBe("just now");
    expect(describeAge("2026-07-28T11:00:00Z", now)).toBe("60 minutes ago");
    expect(describeAge("2026-07-27T12:00:00Z", now)).toBe("24 hours ago");
    expect(describeAge("2026-06-28T12:00:00Z", now)).toBe("30 days ago");
  });
});
