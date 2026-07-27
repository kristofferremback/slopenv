import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { lockPathFor, withLock } from "../src/lock.ts";
import {
  emptyRulesFile,
  fingerprint,
  loadRules,
  parseRules,
  removeRule,
  serializeRules,
  updateRules,
  upsertRule,
  type Rule,
} from "../src/rules.ts";
import { cleanup, tempDir } from "./helpers.ts";

const dirs: string[] = [];
function scratch(): string {
  const dir = tempDir();
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) cleanup(dir);
});

const CLI = join(import.meta.dir, "..", "src", "cli.ts");

describe("parseRules", () => {
  test("round-trips a full rule set, in a stable order", () => {
    const file = {
      version: 1,
      rules: [
        { dir: "/dev/threa", name: "TOKEN", source: "keychain", alias: "Claude Code for work" },
        { dir: "/dev/threa", name: "NODE_ENV", source: "plain", value: "development" },
      ] as Rule[],
    };
    // Serialisation sorts by directory then name, so the file stays diff-friendly
    // no matter what order rules were added in.
    expect(parseRules(serializeRules(file)).rules.map((r) => r.name)).toEqual(["NODE_ENV", "TOKEN"]);
    expect(parseRules(serializeRules(file)).rules).toEqual([file.rules[1] as Rule, file.rules[0] as Rule]);
  });

  test("round-trips values that are hostile to JSON and to shells alike", () => {
    const file = {
      version: 1,
      rules: [{ dir: "/a b/c'd\"e", name: "V", source: "plain", value: "line\n\ttab \\ $x `y` 'z' \"q\" é" }] as Rule[],
    };
    expect(parseRules(serializeRules(file))).toEqual(file);
  });

  test("an empty file is an empty rule set, not an error", () => {
    expect(parseRules("")).toEqual(emptyRulesFile());
  });

  test("rejects, with a reason, everything that is not a valid rules file", () => {
    const cases: [string, RegExp][] = [
      ["{", /not valid JSON/],
      ["[]", /top level must be an object/],
      ['{"rules":[]}', /missing numeric "version"/],
      ['{"version":99,"rules":[]}', /newer slopenv/],
      ['{"version":1}', /"rules" must be an array/],
      ['{"version":1,"rules":[{"dir":"relative","name":"A","source":"plain","value":"x"}]}', /absolute path/],
      ['{"version":1,"rules":[{"dir":"/a","name":"1BAD","source":"plain","value":"x"}]}', /name must match/],
      ['{"version":1,"rules":[{"dir":"/a","name":"A","source":"nope"}]}', /source must be/],
      ['{"version":1,"rules":[{"dir":"/a","name":"A","source":"plain"}]}', /value must be a string/],
      ['{"version":1,"rules":[{"dir":"/a","name":"A","source":"keychain","value":"leak"}]}', /must not be set/],
      [
        '{"version":1,"rules":[{"dir":"/a","name":"A","source":"plain","value":"1"},{"dir":"/a","name":"A","source":"plain","value":"2"}]}',
        /duplicate rule/,
      ],
    ];
    for (const [input, expected] of cases) {
      expect(() => parseRules(input)).toThrow(expected);
    }
  });

  test("a keychain rule never carries a value field", () => {
    const serialized = serializeRules({ version: 1, rules: [{ dir: "/a", name: "T", source: "keychain" }] });
    expect(serialized).not.toContain("value");
  });
});

describe("upsert and remove", () => {
  const base = { version: 1, rules: [{ dir: "/a", name: "T", source: "plain", value: "1" } as Rule] };

  test("upsert replaces the rule with the same dir and name", () => {
    const result = upsertRule(base, { dir: "/a", name: "T", source: "plain", value: "2" });
    expect(result.file.rules).toHaveLength(1);
    expect(result.file.rules[0]?.value).toBe("2");
    expect(result.replaced?.value).toBe("1");
  });

  test("the same name in another directory is a separate rule", () => {
    const result = upsertRule(base, { dir: "/b", name: "T", source: "plain", value: "2" });
    expect(result.file.rules).toHaveLength(2);
    expect(result.replaced).toBeUndefined();
  });

  test("remove reports what it took out", () => {
    expect(removeRule(base, "/a", "T").removed?.value).toBe("1");
    expect(removeRule(base, "/a", "OTHER").removed).toBeUndefined();
  });
});

describe("on-disk behaviour", () => {
  test("a missing rules file reads as empty", () => {
    expect(loadRules(join(scratch(), "nope.json")).rules).toEqual([]);
  });

  test("the file is written 0600 in a 0700 directory", () => {
    const parent = join(scratch(), "nested");
    const path = join(parent, "rules.json");
    updateRules(path, (file) => upsertRule(file, { dir: "/a", name: "T", source: "plain", value: "1" }).file);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(statSync(parent).mode & 0o777).toBe(0o700);
  });

  test("the fingerprint changes on every write and is stable in between", () => {
    const path = join(scratch(), "rules.json");
    expect(fingerprint(path)).toBe("0:0:0");

    updateRules(path, (file) => upsertRule(file, { dir: "/a", name: "A", source: "plain", value: "1" }).file);
    const first = fingerprint(path);
    expect(first).not.toBe("0:0:0");
    expect(fingerprint(path)).toBe(first);

    updateRules(path, (file) => upsertRule(file, { dir: "/b", name: "B", source: "plain", value: "2" }).file);
    // Same second, same size is possible — the inode is what makes this reliable,
    // because every write lands via rename onto a fresh file.
    expect(fingerprint(path)).not.toBe(first);
  });

  test("no temp files are left behind", () => {
    const dir = scratch();
    const path = join(dir, "rules.json");
    updateRules(path, (file) => upsertRule(file, { dir: "/a", name: "A", source: "plain", value: "1" }).file);
    const leftovers = Array.from(new Bun.Glob("*").scanSync(dir)).filter((f) => f !== "rules.json");
    expect(leftovers).toEqual([]);
  });
});

describe("locking", () => {
  test("the lock file is removed even when the body throws", () => {
    const path = join(scratch(), "rules.json");
    expect(() =>
      withLock(path, () => {
        throw new Error("boom");
      }),
    ).toThrow("boom");
    expect(existsSync(lockPathFor(path))).toBe(false);
  });

  test("a lock held by a live process is waited on, then times out with advice", () => {
    const path = join(scratch(), "rules.json");
    writeFileSync(lockPathFor(path), JSON.stringify({ pid: process.pid, ts: Date.now() }));
    const started = Date.now();
    expect(() => withLock(path, () => 1, { timeoutMs: 120 })).toThrow(/another slopenv process is writing/);
    expect(Date.now() - started).toBeGreaterThanOrEqual(100);
  });

  test("a lock whose owner is gone is broken rather than waited on", () => {
    const path = join(scratch(), "rules.json");
    // PID 2^22 is above the macOS maximum, so it cannot be a live process.
    writeFileSync(lockPathFor(path), JSON.stringify({ pid: 4194303, ts: Date.now() }));
    expect(withLock(path, () => "ran", { timeoutMs: 500 })).toBe("ran");
  });

  test("an ancient lock is broken even if its owner cannot be identified", () => {
    const path = join(scratch(), "rules.json");
    writeFileSync(lockPathFor(path), "not json at all");
    expect(withLock(path, () => "ran", { timeoutMs: 500, staleMs: -1 })).toBe("ran");
  });
});

describe("concurrent writers", () => {
  test("16 processes each adding a rule lose none of them", async () => {
    const dir = scratch();
    const rulesPath = join(dir, "rules.json");
    const count = 16;

    const procs = Array.from({ length: count }, (_, i) =>
      Bun.spawn(["bun", CLI, "set", `VAR_${i}`, `value_${i}`, dir], {
        env: { ...process.env, SLOPENV_CONFIG: rulesPath },
        stdout: "pipe",
        stderr: "pipe",
      }),
    );

    const exits = await Promise.all(procs.map((p) => p.exited));
    expect(exits.every((code) => code === 0)).toBe(true);

    const rules = loadRules(rulesPath).rules;
    expect(rules).toHaveLength(count);
    for (let i = 0; i < count; i++) {
      expect(rules.find((r) => r.name === `VAR_${i}`)?.value).toBe(`value_${i}`);
    }
    expect(existsSync(lockPathFor(rulesPath))).toBe(false);
  }, 30_000);

  test("a reader never sees a torn file while writers hammer it", async () => {
    const dir = scratch();
    const rulesPath = join(dir, "rules.json");

    const writers = Array.from({ length: 8 }, (_, i) =>
      Bun.spawn(["bun", CLI, "set", `VAR_${i}`, "x".repeat(500), dir], {
        env: { ...process.env, SLOPENV_CONFIG: rulesPath },
        stdout: "ignore",
        stderr: "ignore",
      }),
    );

    let reads = 0;
    const deadline = Date.now() + 1500;
    while (Date.now() < deadline) {
      if (existsSync(rulesPath)) {
        // Throws if it ever observes a partially written file.
        parseRules(readFileSync(rulesPath, "utf8"));
        reads++;
      }
    }

    await Promise.all(writers.map((p) => p.exited));
    expect(reads).toBeGreaterThan(0);
    expect(loadRules(rulesPath).rules).toHaveLength(8);
  }, 30_000);
});
