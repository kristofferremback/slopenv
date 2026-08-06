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
import { run } from "../src/cli.ts";
import { cleanup, harness, tempDir, type Harness } from "./helpers.ts";

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

/** `pull` is async (it overlaps vault reads); everything else here is not. */
async function cli(...argv: string[]): Promise<number> {
  h.reset();
  return await run(argv, h.ctx);
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
  test("fetches, caches in the keychain, and records the reference", async () => {
    expect(await cli("pull", "TOKEN", "--ref", "op://Work/Claude Code/credential")).toBe(0);

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

  test("passes the reference as one argument, with no shell in between", async () => {
    // A reference full of shell metacharacters is the whole point of argv.
    const ref = `op://Work/It's "risky"; $(touch ${root}/pwned)/credential`;
    await cli("pull", "TOKEN", "--ref", ref);

    expect(calls()).toEqual([`op read ${ref}`]);
    expect(() => readFileSync(join(root, "pwned"))).toThrow();
  });

  test("the rules file holds a reference, never the secret", async () => {
    await cli("pull", "TOKEN", "--ref", "op://Work/Claude/credential");
    const text = readFileSync(rulesPath, "utf8");
    expect(text).toContain("op://Work/Claude/credential");
    expect(text).not.toContain("sk-from-1password");
  });

  test("trims the newline op prints, and nothing else", async () => {
    fakeOp(`printf 'value-with-trailing-space \\n'`);
    await cli("pull", "TOKEN", "--ref", "op://a/b/c");
    expect(h.store.get(work, "TOKEN")).toBe("value-with-trailing-space ");
  });

  test("a directory argument works the same way it does for set", async () => {
    await cli("pull", "TOKEN", apps, "--ref", "op://a/b/c");
    expect((loadRules(rulesPath).rules[0] as Rule).dir).toBe(apps);
    expect(h.store.get(apps, "TOKEN")).toBe("sk-from-1password");
  });

  test("re-pulling needs no reference, and keeps the alias and the window", async () => {
    await cli("pull", "TOKEN", "--ref", "op://a/b/c", "--alias", "Work token", "--ttl", "30d");
    const first = loadRules(rulesPath).rules[0] as Rule;
    expect(first.alias).toBe("Work token");
    expect(first.ttl).toBe(2_592_000);

    fakeOp(`printf 'rotated\\n'`);
    expect(await cli("pull", "TOKEN")).toBe(0);

    const second = loadRules(rulesPath).rules[0] as Rule;
    expect(second.ref).toBe("op://a/b/c");
    expect(second.alias).toBe("Work token");
    expect(second.ttl).toBe(2_592_000);
    expect(h.store.get(work, "TOKEN")).toBe("rotated");
    expect(h.stdout()).toContain("pulled from");
  });

  test("says when a value came back unchanged", async () => {
    await cli("pull", "TOKEN", "--ref", "op://a/b/c");
    expect(await cli("pull", "TOKEN")).toBe(0);
    expect(h.stdout()).toContain("unchanged");
  });

  test("refuses to pull a rule that has no reference, and says how to give it one", async () => {
    await cli("set", "PORT=3000");
    await expect(cli("pull", "PORT")).rejects.toThrow(/no secret reference[\s\S]*plain rule[\s\S]*--ref/);
  });
});

describe("when op fails", () => {
  test("nothing is written — no rule, no secret-store entry", async () => {
    fakeOp(`echo '[ERROR] item "Nope" doesn.t exist' >&2; exit 1`);
    await expect(cli("pull", "TOKEN", "--ref", "op://Work/Nope/credential")).rejects.toThrow(/could not read/);

    expect(h.store.get(work, "TOKEN")).toBeNull();
    expect(loadRules(rulesPath).rules).toEqual([]);
  });

  test("op's own message is shown, with advice when it is one we recognise", async () => {
    fakeOp(`echo '[ERROR] you are not currently signed in' >&2; exit 1`);
    await expect(cli("pull", "TOKEN", "--ref", "op://a/b/c")).rejects.toThrow(/op signin/);
  });

  test("an empty value is refused rather than cached", async () => {
    fakeOp(`printf '\\n'`);
    await expect(cli("pull", "TOKEN", "--ref", "op://a/b/c")).rejects.toThrow(/empty value/);
    expect(h.store.get(work, "TOKEN")).toBeNull();
  });

  test("a missing op says how to install it, rather than reporting ENOENT", async () => {
    h = harness({ rulesPath, cwd: work, env: { PATH: join(root, "empty") } });
    await expect(cli("pull", "TOKEN", "--ref", "op://a/b/c")).rejects.toThrow(/brew install 1password-cli/);
  });

  test("a reference slopenv has no engine for is refused before anything runs", async () => {
    await expect(cli("pull", "TOKEN", "--ref", "bw://item/field")).rejects.toThrow(/no vault engine/);
    await expect(cli("pull", "TOKEN", "--ref", "just-a-string")).rejects.toThrow(/is not a secret reference/);
    expect(calls()).toEqual([]);
  });

  test("--engine that disagrees with the reference is refused", async () => {
    await expect(cli("pull", "TOKEN", "--ref", "op://a/b/c", "--engine", "bitwarden")).rejects.toThrow(/unknown engine/);
  });
});

describe("pull --all", () => {
  beforeEach(async () => {
    await cli("pull", "TOKEN", "--ref", "op://Work/One/credential");
    await cli("pull", "OTHER", apps, "--ref", "op://Work/Two/credential");
    await cli("set", "PORT=3000");
  });

  test("re-fetches every reference and leaves other rules alone", async () => {
    fakeOp(`printf 'refreshed\\n'`);
    expect(await cli("pull", "--all")).toBe(0);

    expect(h.store.get(work, "TOKEN")).toBe("refreshed");
    expect(h.store.get(apps, "OTHER")).toBe("refreshed");
    expect(h.stdout()).toContain("2 of 2 pulled");

    // The plain rule was not touched, and no vault call was made for it.
    expect(loadRules(rulesPath).rules.find((r) => r.name === "PORT")?.value).toBe("3000");
    expect(calls().filter((c) => c.includes("PORT"))).toEqual([]);
  });

  test("one failure does not stop the rest, and the exit code says so", async () => {
    fakeOp(`case "$2" in *One*) echo 'nope' >&2; exit 1;; *) printf 'refreshed\\n';; esac`);
    expect(await cli("pull", "--all")).toBe(1);

    expect(h.store.get(apps, "OTHER")).toBe("refreshed");
    expect(h.stdout()).toContain("1 of 2 pulled");
    expect(h.stdout()).toContain("slopenv pull TOKEN");
    expect(h.stderr()).toContain("nope");
  });

  test("a failed pull does not get a fresh timestamp", async () => {
    const before = loadRules(rulesPath).rules.find((r) => r.name === "TOKEN")?.fetched;
    fakeOp(`echo 'nope' >&2; exit 1`);
    await cli("pull", "--all");
    expect(loadRules(rulesPath).rules.find((r) => r.name === "TOKEN")?.fetched).toBe(before as string);
  });

  test("writes the rules file once, not once per secret", async () => {
    fakeOp(`printf 'refreshed\\n'`);
    const before = readFileSync(rulesPath, "utf8");
    await cli("pull", "--all");
    // Every write changes the fingerprint and makes live shells re-resolve, so
    // batching is not just tidiness.
    const after = loadRules(rulesPath).rules.filter((r) => r.source === "vault");
    expect(after).toHaveLength(2);
    expect(before).not.toBe(readFileSync(rulesPath, "utf8"));
  });

  test("says what to do when there is nothing to pull", async () => {
    h = harness({ rulesPath: join(root, "empty.json"), cwd: work, env: { PATH: binDir } });
    expect(await cli("pull", "--all")).toBe(0);
    expect(h.stdout()).toContain("no vault references yet");
  });
});

describe("pull --all overlaps the waiting", () => {
  /**
   * A vault read is ~1.2s of network round trip that no amount of local work
   * makes shorter, so the only way to make twenty of them bearable is to overlap
   * them. This measures that without measuring time: each fake `op` appends a
   * line when it starts and another when it finishes, and since those appends are
   * ordered, the running total over the file *is* the number in flight.
   */
  let concurrencyLog: string;

  function overlapping(): { max: number; firstRanAlone: boolean } {
    const events = readFileSync(concurrencyLog, "utf8").split("\n").filter(Boolean);
    let inFlight = 0;
    let max = 0;
    for (const event of events) {
      inFlight += event === "start" ? 1 : -1;
      max = Math.max(max, inFlight);
    }
    // The very first read is deliberately alone: it is the one that may raise a
    // biometric prompt, and four of those at once would be a race over one dialog.
    return { max, firstRanAlone: events[0] === "start" && events[1] === "end" };
  }

  /** A fake `op` slow enough that overlap is unambiguous. */
  function slowFakeOp(): void {
    const path = join(binDir, "op");
    writeFileSync(
      path,
      // /bin/sleep by absolute path: the child's PATH is only the fake bin dir,
      // so a bare `sleep` is not found and fails silently — which would make this
      // measure nothing at all.
      `#!/bin/sh\necho start >> ${JSON.stringify(concurrencyLog)}\n/bin/sleep 0.3\nprintf 'value\\n'\necho end >> ${JSON.stringify(concurrencyLog)}\n`,
      { mode: 0o755 },
    );
    chmodSync(path, 0o755);
  }

  beforeEach(async () => {
    concurrencyLog = join(root, "concurrency.log");
    for (let i = 0; i < 9; i++) {
      const dir = join(root, `repo-${i}`);
      mkdirSync(dir, { recursive: true });
      await cli("pull", `TOKEN_${i}`, dir, "--ref", `op://Work/Item${i}/credential`);
    }
    writeFileSync(concurrencyLog, "");
    slowFakeOp();
  });

  test("reads run four at a time, after a first one on its own", async () => {
    expect(await cli("pull", "--all")).toBe(0);

    const { max, firstRanAlone } = overlapping();
    expect(firstRanAlone).toBe(true);
    expect(max).toBeGreaterThan(1);
    expect(max).toBeLessThanOrEqual(4);
  });

  test("nine reads take nowhere near nine times one read", async () => {
    const started = Date.now();
    await cli("pull", "--all");
    const elapsed = Date.now() - started;

    // Sequentially this is 9 x 300ms (measured: ~2880ms). Overlapped it is 300ms
    // for the first, then two rounds of four (~900ms). The threshold sits between
    // the two with room on both sides — it is the shape being asserted, not a
    // stopwatch reading.
    expect(elapsed).toBeLessThan(1800);
    expect(loadRules(rulesPath).rules.filter((r) => r.source === "vault")).toHaveLength(9);
  });

  test("results are reported in rule order however they interleave", async () => {
    await cli("pull", "--all");
    const names = [...h.stdout().matchAll(/TOKEN_(\d)/g)].map((m) => m[1]);
    expect(names).toEqual([...names].sort());
  });

  test("one bad reference among many still costs only that one", async () => {
    const path = join(binDir, "op");
    writeFileSync(
      path,
      `#!/bin/sh\ncase "$2" in *Item3*) echo 'nope' >&2; exit 1;; esac\nprintf 'value\\n'\n`,
      { mode: 0o755 },
    );
    chmodSync(path, 0o755);

    expect(await cli("pull", "--all")).toBe(1);
    expect(h.stdout()).toContain("8 of 9 pulled");
    expect(h.stdout()).toContain("slopenv pull TOKEN_3");
    expect(h.store.get(join(root, "repo-4"), "TOKEN_4")).toBe("value");
  });
});

describe("pull --plain: values that are not secrets", () => {
  test("keeps the value in the rules file, in the clear, and out of the keychain", async () => {
    fakeOp(`printf 'kristoffer@example.com\\n'`);
    expect(await cli("pull", "NOTION_USER", "--ref", "op://Employee/Notion/Username", "--plain")).toBe(0);

    const rule = loadRules(rulesPath).rules[0] as Rule;
    expect(rule.source).toBe("vault");
    expect(rule.store).toBe("file");
    expect(rule.value).toBe("kristoffer@example.com");
    expect(rule.ref).toBe("op://Employee/Notion/Username");
    expect(h.store.get(work, "NOTION_USER")).toBeNull();

    // Shown in full: masking a value that is sitting in a file in the clear would
    // only pretend to a secrecy it does not have.
    expect(h.stdout()).toContain("kristoffer@example.com");
    expect(h.stdout()).not.toContain("•••");
  });

  test("the hot path exports it without touching the keychain", async () => {
    fakeOp(`printf 'kristoffer@example.com\\n'`);
    await cli("pull", "NOTION_USER", "--ref", "op://a/b/c", "--plain");
    writeFileSync(callLog, "");

    expect(await cli("export", work)).toBe(0);
    expect(h.stdout()).toContain(`export NOTION_USER='kristoffer@example.com'`);
    expect(calls()).toEqual([]);
  });

  test("the keychain is still the default", async () => {
    await cli("pull", "TOKEN", "--ref", "op://a/b/c");
    expect((loadRules(rulesPath).rules[0] as Rule).store).toBeUndefined();
    expect(h.store.get(work, "TOKEN")).toBe("sk-from-1password");
  });

  test("re-pulling keeps it where you put it", async () => {
    fakeOp(`printf 'first@example.com\\n'`);
    await cli("pull", "NOTION_USER", "--ref", "op://a/b/c", "--plain");

    fakeOp(`printf 'second@example.com\\n'`);
    expect(await cli("pull", "NOTION_USER")).toBe(0);

    const rule = loadRules(rulesPath).rules[0] as Rule;
    expect(rule.store).toBe("file");
    expect(rule.value).toBe("second@example.com");
    expect(h.store.get(work, "NOTION_USER")).toBeNull();
  });

  test("--secret moves it back, and takes the plain-text copy with it", async () => {
    fakeOp(`printf 'kristoffer@example.com\\n'`);
    await cli("pull", "NOTION_USER", "--ref", "op://a/b/c", "--plain");
    expect(await cli("pull", "NOTION_USER", "--secret")).toBe(0);

    const rule = loadRules(rulesPath).rules[0] as Rule;
    expect(rule.store).toBeUndefined();
    expect(rule.value).toBeUndefined();
    expect(h.store.get(work, "NOTION_USER")).toBe("kristoffer@example.com");
  });

  test("--plain over a keychain-stored one deletes the keychain entry", async () => {
    await cli("pull", "TOKEN", "--ref", "op://a/b/c");
    expect(h.store.get(work, "TOKEN")).toBe("sk-from-1password");

    expect(await cli("pull", "TOKEN", "--plain", "--yes")).toBe(0);
    // Not left behind: that is how a keychain fills with orphans.
    expect(h.store.get(work, "TOKEN")).toBeNull();
    expect((loadRules(rulesPath).rules[0] as Rule).value).toBe("sk-from-1password");
  });

  test("refuses to write something that looks like a credential", async () => {
    fakeOp(`printf 'sk-ant-oat01-abcdefghijklmnop\\n'`);
    await expect(cli("pull", "TOKEN", "--ref", "op://a/b/c", "--plain")).rejects.toThrow(
      /refusing to write what looks like a credential/,
    );
    expect(loadRules(rulesPath).rules).toEqual([]);
    expect(h.store.get(work, "TOKEN")).toBeNull();
    expect(h.stderr()).toContain("--plain writes it to");
  });

  test("--yes overrides that, since it is a guard rail and not a wall", async () => {
    fakeOp(`printf 'sk-ant-oat01-abcdefghijklmnop\\n'`);
    expect(await cli("pull", "TOKEN", "--ref", "op://a/b/c", "--plain", "--yes")).toBe(0);
    expect((loadRules(rulesPath).rules[0] as Rule).value).toBe("sk-ant-oat01-abcdefghijklmnop");
  });

  test("doctor still calls that out, and says how to undo it", async () => {
    fakeOp(`printf 'sk-ant-oat01-abcdefghijklmnop\\n'`);
    await cli("pull", "TOKEN", "--ref", "op://a/b/c", "--plain", "--yes");

    expect(await cli("doctor")).toBe(1);
    expect(h.stdout()).toContain("stored in plain text");
    expect(h.stdout()).toContain("slopenv pull TOKEN --secret");
  });

  test("--plain and --secret together are refused, and neither works with --all", async () => {
    await expect(cli("pull", "T", "--ref", "op://a/b/c", "--plain", "--secret")).rejects.toThrow(/opposites/);
    await expect(cli("pull", "--all", "--plain")).rejects.toThrow(/one reference at a time/);
  });

  test("--all keeps each reference where it already lives", async () => {
    fakeOp(`printf 'kristoffer@example.com\\n'`);
    await cli("pull", "NOTION_USER", "--ref", "op://a/b/c", "--plain");
    fakeOp(`printf 'sk-from-1password\\n'`);
    await cli("pull", "TOKEN", apps, "--ref", "op://d/e/f");

    fakeOp(`printf 'refreshed\\n'`);
    expect(await cli("pull", "--all")).toBe(0);

    const rules = loadRules(rulesPath).rules;
    expect(rules.find((r) => r.name === "NOTION_USER")?.value).toBe("refreshed");
    expect(rules.find((r) => r.name === "TOKEN")?.value).toBeUndefined();
    expect(h.store.get(work, "NOTION_USER")).toBeNull();
    expect(h.store.get(apps, "TOKEN")).toBe("refreshed");
  });

  test("list shows it in full while a keychain-stored one stays masked", async () => {
    fakeOp(`printf 'kristoffer@example.com\\n'`);
    await cli("pull", "NOTION_USER", "--ref", "op://a/b/c", "--plain");
    fakeOp(`printf 'sk-from-1password\\n'`);
    await cli("pull", "TOKEN", apps, "--ref", "op://d/e/f");

    await cli("list");
    expect(h.stdout()).toContain("kristoffer@example.com");
    expect(h.stdout()).toContain("•••word");
  });

  test("rm takes the plain-text value with the rule", async () => {
    fakeOp(`printf 'kristoffer@example.com\\n'`);
    await cli("pull", "NOTION_USER", "--ref", "op://a/b/c", "--plain");
    expect(await cli("rm", "NOTION_USER")).toBe(0);
    expect(loadRules(rulesPath).rules).toEqual([]);
  });
});

describe("the hot path never talks to the vault", () => {
  test("export reads the cached value and spawns nothing", async () => {
    await cli("pull", "TOKEN", "--ref", "op://Work/One/credential");
    writeFileSync(callLog, "");

    expect(await cli("export", work)).toBe(0);
    expect(h.stdout()).toContain(`export TOKEN='sk-from-1password'`);
    expect(calls()).toEqual([]);
  });

  test("a reference with no cached value yet points at pull, not set", async () => {
    const rule: Rule = { dir: work, name: "TOKEN", source: "vault", ref: "op://a/b/c", engine: "1password" };
    const plan = await computePlan({
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

  test("an overdue value is still exported, with a word about it", async () => {
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
    const plan = await computePlan({
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

  test("no ttl means no nagging", async () => {
    const store = new MemorySecretStore({ [accountFor(work, "TOKEN")]: "cached" });
    const rule: Rule = {
      dir: work,
      name: "TOKEN",
      source: "vault",
      ref: "op://a/b/c",
      engine: "1password",
      fetched: new Date("2020-01-01T00:00:00Z").toISOString(),
    };
    const plan = await computePlan({ rules: [rule], pwd: work, prevState: emptyState(), env: {}, store, rev: "r1" });
    expect(plan.warnings).toEqual([]);
  });
});

describe("vault rules alongside everything else", () => {
  test("a link can borrow from a reference, and follows a re-pull", async () => {
    const web = join(root, "web");
    mkdirSync(web, { recursive: true });

    await cli("pull", "TOKEN", "--ref", "op://Work/One/credential");
    expect(await cli("link", "TOKEN", "--from", work, web)).toBe(0);

    // One value, one keychain entry, two directories — the link resolves through
    // the vault rule to the same cached secret.
    expect(await cli("export", web)).toBe(0);
    expect(h.stdout()).toContain(`export TOKEN='sk-from-1password'`);

    fakeOp(`printf 'rotated\\n'`);
    await cli("pull", "TOKEN");
    expect(await cli("export", web)).toBe(0);
    expect(h.stdout()).toContain(`export TOKEN='rotated'`);
  });

  test("rm takes the cached value with it", async () => {
    await cli("pull", "TOKEN", "--ref", "op://a/b/c");
    expect(await cli("rm", "TOKEN")).toBe(0);
    expect(h.store.get(work, "TOKEN")).toBeNull();
    expect(h.stdout()).toContain("its cached value");
  });

  test("replacing a reference with a plain value clears the cache and says so", async () => {
    await cli("pull", "TOKEN", "--ref", "op://a/b/c");
    expect(await cli("set", "TOKEN=plain-now", "--yes")).toBe(0);
    expect(h.store.get(work, "TOKEN")).toBeNull();
    expect(h.stderr()).toContain("used to pull op://a/b/c");
  });

  test("set --secret over a reference detaches it", async () => {
    await cli("pull", "TOKEN", "--ref", "op://a/b/c");
    expect(await cli("set", "--secret", "TOKEN=typed-by-hand")).toBe(0);
    expect(loadRules(rulesPath).rules[0]?.source).toBe("keychain");
    expect(loadRules(rulesPath).rules[0]?.ref).toBeUndefined();
    expect(h.store.get(work, "TOKEN")).toBe("typed-by-hand");
  });

  test("list shows the reference, and doctor reports the cache", async () => {
    await cli("pull", "TOKEN", "--ref", "op://Work/One/credential", "--alias", "Work token");

    await cli("list");
    expect(h.stdout()).toContain("FROM");
    expect(h.stdout()).toContain("op://Work/One/credential");
    expect(h.stdout()).toContain("Work token");

    await cli("doctor");
    expect(h.stdout()).toContain("vault references (1)");
    expect(h.stdout()).toContain("pulled just now");
  });

  test("doctor calls a missing cache a failure, since that is what breaks the hot path", async () => {
    await cli("pull", "TOKEN", "--ref", "op://a/b/c");
    h.store.remove(work, "TOKEN");
    expect(await cli("doctor")).toBe(1);
    expect(h.stdout()).toContain("nothing stored yet");
  });
});

describe("the rules file", () => {
  test("only claims version 3 once it actually contains a reference", async () => {
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

  test("refuses the malformed shapes a vault rule can take", async () => {
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

describe("advice is pinned to what op actually says", () => {
  /**
   * Verbatim from `op` 2.35, collected by pointing the real binary at references
   * that do not resolve. Guessed-at strings are how a hint ends up firing on the
   * wrong failure and sending someone off in the wrong direction.
   */
  const REAL_ERRORS: [string, RegExp][] = [
    [
      `[ERROR] 2026/07/28 14:36:07 could not read secret 'op://Employee/NoSuchItem/Username': could not get item Employee/NoSuchItem: "NoSuchItem" isn't an item in the "Employee" vault. Specify the item with its UUID, name, or domain.`,
      /op item list/,
    ],
    [
      `[ERROR] 2026/07/28 14:36:08 could not read secret 'op://NoSuchVault/Notion/Username': could not get item NoSuchVault/Notion: "NoSuchVault" isn't a vault in this account. Specify the vault with its ID or name.`,
      /op vault list/,
    ],
    [
      `[ERROR] 2026/07/28 14:35:57 could not read secret 'op://Employee/Notion/NoSuchField': item 'Employee/Notion' does not have a field 'NoSuchField'`,
      /the item is there but the field is not/,
    ],
    [
      `[ERROR] 2026/07/28 14:36:08 could not read secret 'op://Employee/Notion': invalid secret reference 'op://Employee/Notion': too few '/': secret references should have at least vault, item and field specified`,
      /op:\/\/VAULT\/ITEM\/FIELD/,
    ],
  ];

  test("each real failure gets the advice that fits it", async () => {
    const engine = engineForRef("op://a/b/c");
    for (const [stderr, expected] of REAL_ERRORS) {
      expect(engine.hint(stderr)).toMatch(expected);
    }
  });

  test("an unfamiliar failure gets no invented advice", async () => {
    const engine = engineForRef("op://a/b/c");
    expect(engine.hint("[ERROR] something nobody has seen before")).toBeNull();
  });

  test("the failure and the advice both reach the user", async () => {
    fakeOp(`echo "item 'Employee/Notion' does not have a field 'Nope'" >&2; exit 1`);
    await expect(cli("pull", "TOKEN", "--ref", "op://Employee/Notion/Nope")).rejects.toThrow(
      /does not have a field[\s\S]*the item is there but the field is not/,
    );
  });
});

describe("small parts", () => {
  test("references map to engines by scheme", async () => {
    expect(engineForRef("op://a/b/c").id).toBe("1password");
    expect(() => engineForRef("op:/a/b")).toThrow(/not a secret reference/);
  });

  test("only the newline the CLI added is removed", async () => {
    expect(trimOneNewline("value\n")).toBe("value");
    expect(trimOneNewline("value\r\n")).toBe("value");
    expect(trimOneNewline("value\n\n")).toBe("value\n");
    expect(trimOneNewline("value")).toBe("value");
    expect(trimOneNewline("va\nlue")).toBe("va\nlue");
  });

  test("durations round-trip", async () => {
    expect(parseDuration("30d")).toBe(2_592_000);
    expect(parseDuration("12h")).toBe(43_200);
    expect(parseDuration("90")).toBe(90);
    expect(formatDuration(2_592_000)).toBe("30d");
    expect(formatDuration(90)).toBe("90s");
    expect(() => parseDuration("soon")).toThrow(/invalid duration/);
    expect(() => parseDuration("0d")).toThrow(/greater than zero/);
  });

  test("ages read the way a person would say them", async () => {
    const now = Date.parse("2026-07-28T12:00:00Z");
    expect(describeAge("2026-07-28T11:59:30Z", now)).toBe("just now");
    expect(describeAge("2026-07-28T11:00:00Z", now)).toBe("60 minutes ago");
    expect(describeAge("2026-07-27T12:00:00Z", now)).toBe("24 hours ago");
    expect(describeAge("2026-06-28T12:00:00Z", now)).toBe("30 days ago");
  });
});
