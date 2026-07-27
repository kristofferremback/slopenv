import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cmdUpdate } from "../src/commands/update.ts";
import {
  assetNameFor,
  checksumFor,
  compareVersions,
  installBinary,
  parseRelease,
  updateBlocker,
} from "../src/update.ts";
import { VERSION } from "../src/version.ts";
import { cleanup, harness, tempDir } from "./helpers.ts";

describe("version comparison", () => {
  test("orders releases correctly, with or without the v", () => {
    expect(compareVersions("0.1.2", "0.1.1")).toBeGreaterThan(0);
    expect(compareVersions("v0.2.0", "0.1.9")).toBeGreaterThan(0);
    expect(compareVersions("1.0.0", "0.99.99")).toBeGreaterThan(0);
    expect(compareVersions("0.1.1", "0.1.1")).toBe(0);
    expect(compareVersions("v0.1.1", "0.1.1")).toBe(0);
    expect(compareVersions("0.1.1", "0.1.2")).toBeLessThan(0);
  });

  test("does not compare 0.1.10 as older than 0.1.9", () => {
    expect(compareVersions("0.1.10", "0.1.9")).toBeGreaterThan(0);
  });

  test("treats a missing component as zero", () => {
    expect(compareVersions("1.0", "1.0.0")).toBe(0);
    expect(compareVersions("1.0.1", "1.0")).toBeGreaterThan(0);
  });
});

describe("asset selection", () => {
  test("picks the build for this machine", () => {
    expect(assetNameFor("darwin", "arm64")).toBe("slopenv-darwin-arm64.tar.gz");
    expect(assetNameFor("darwin", "x64")).toBe("slopenv-darwin-x64.tar.gz");
  });

  test("refuses platforms and architectures nothing is published for", () => {
    expect(() => assetNameFor("linux", "x64")).toThrow(/only ships macOS/);
    expect(() => assetNameFor("darwin", "ppc")).toThrow(/arm64 and x64/);
  });
});

describe("checksum parsing", () => {
  const sums = [
    "1111111111111111111111111111111111111111111111111111111111111111  slopenv-darwin-arm64.tar.gz",
    "2222222222222222222222222222222222222222222222222222222222222222  slopenv-darwin-x64.tar.gz",
  ].join("\n");

  test("finds the line for one file", () => {
    expect(checksumFor(sums, "slopenv-darwin-arm64.tar.gz")).toBe("1".repeat(64));
    expect(checksumFor(sums, "slopenv-darwin-x64.tar.gz")).toBe("2".repeat(64));
  });

  test("matches on the basename, since shasum output can carry a path", () => {
    expect(checksumFor(`${"3".repeat(64)}  dist/slopenv-darwin-arm64.tar.gz`, "slopenv-darwin-arm64.tar.gz")).toBe(
      "3".repeat(64),
    );
  });

  test("returns null rather than guessing when the file is absent", () => {
    expect(checksumFor(sums, "slopenv-darwin-riscv.tar.gz")).toBe(null);
    expect(checksumFor("", "slopenv-darwin-arm64.tar.gz")).toBe(null);
    expect(checksumFor("not a checksum line at all", "slopenv-darwin-arm64.tar.gz")).toBe(null);
  });
});

describe("release parsing", () => {
  test("reads the tag and the downloadable assets", () => {
    const release = parseRelease({
      tag_name: "v0.9.9",
      assets: [
        { name: "slopenv-darwin-arm64.tar.gz", browser_download_url: "https://example.invalid/a" },
        { name: "SHA256SUMS", browser_download_url: "https://example.invalid/s" },
        { name: "no-url" },
      ],
    });
    expect(release.tag).toBe("v0.9.9");
    expect(release.assets.map((a) => a.name)).toEqual(["slopenv-darwin-arm64.tar.gz", "SHA256SUMS"]);
  });

  test("rejects responses it cannot use", () => {
    expect(() => parseRelease(null)).toThrow(/unexpected response/);
    expect(() => parseRelease({ assets: [] })).toThrow(/no tag_name/);
    expect(() => parseRelease({ tag_name: "v1" })).toThrow(/no assets/);
  });
});

describe("installs that must not be replaced", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) cleanup(d);
  });
  function scratch(): string {
    const d = realpathSync(tempDir());
    dirs.push(d);
    return d;
  }

  test("running from source under bun", () => {
    expect(updateBlocker("/usr/local/bin/bun")).toMatch(/running from source/);
    expect(updateBlocker("/opt/homebrew/bin/bun-debug")).toMatch(/running from source/);
  });

  test("a local build sitting inside the slopenv repo", () => {
    const repo = scratch();
    writeFileSync(join(repo, "package.json"), JSON.stringify({ name: "slopenv", version: "0.0.0" }));
    const binary = join(repo, "slopenv");
    writeFileSync(binary, "#!/bin/sh\n", { mode: 0o755 });

    expect(updateBlocker(binary)).toMatch(/local build inside the slopenv repo/);
    expect(updateBlocker(binary)).toMatch(/bun run build/);
  });

  test("a directory that cannot be written to", () => {
    const dir = scratch();
    const binary = join(dir, "slopenv");
    writeFileSync(binary, "#!/bin/sh\n", { mode: 0o755 });
    chmodSync(dir, 0o500);
    try {
      expect(updateBlocker(binary)).toMatch(/not writable/);
    } finally {
      chmodSync(dir, 0o700);
    }
  });

  test("an ordinary install is fine", () => {
    const dir = scratch();
    const binary = join(dir, "slopenv");
    writeFileSync(binary, "#!/bin/sh\n", { mode: 0o755 });
    expect(updateBlocker(binary)).toBe(null);
  });

  test("a neighbouring package.json for something else does not block it", () => {
    const dir = scratch();
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "something-else" }));
    const binary = join(dir, "slopenv");
    writeFileSync(binary, "#!/bin/sh\n", { mode: 0o755 });
    expect(updateBlocker(binary)).toBe(null);
  });
});

describe("swapping the binary", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) cleanup(d);
  });
  function scratch(): string {
    const d = realpathSync(tempDir());
    dirs.push(d);
    return d;
  }

  /** A stand-in binary that reports whatever version it was made with. */
  function fakeBinary(path: string, version: string, exitCode = 0): string {
    writeFileSync(path, `#!/bin/sh\necho "${version}"\nexit ${exitCode}\n`, { mode: 0o755 });
    chmodSync(path, 0o755);
    return path;
  }

  test("replaces the target and leaves nothing behind", () => {
    const dir = scratch();
    const target = fakeBinary(join(dir, "slopenv"), "0.1.0");
    const staged = fakeBinary(join(scratch(), "new"), "0.2.0");

    installBinary({ targetPath: target, stagedPath: staged, expectedVersion: "0.2.0" });

    expect(readFileSync(target, "utf8")).toContain("0.2.0");
    const leftovers = Array.from(new Bun.Glob(".*").scanSync({ cwd: dir, dot: true }));
    expect(leftovers).toEqual([]);
  });

  test("refuses a download that reports the wrong version, keeping the working binary", () => {
    const dir = scratch();
    const target = fakeBinary(join(dir, "slopenv"), "0.1.0");
    const staged = fakeBinary(join(scratch(), "new"), "0.1.0");

    expect(() => installBinary({ targetPath: target, stagedPath: staged, expectedVersion: "0.2.0" })).toThrow(
      /reports "0.1.0" but the release says "0.2.0"/,
    );
    expect(readFileSync(target, "utf8")).toContain("0.1.0");
  });

  test("refuses a download that will not run at all", () => {
    const dir = scratch();
    const target = fakeBinary(join(dir, "slopenv"), "0.1.0");
    const staged = fakeBinary(join(scratch(), "new"), "0.2.0", 1);

    expect(() => installBinary({ targetPath: target, stagedPath: staged, expectedVersion: "0.2.0" })).toThrow(
      /does not run/,
    );
    expect(readFileSync(target, "utf8")).toContain("0.1.0");
  });
});

/**
 * The whole command against a fake release served locally: fetch the metadata,
 * download, verify the checksum, unpack, run the new binary, swap it in. No
 * network, so it runs in CI.
 */
describe("update end to end, against a local release", () => {
  let server: ReturnType<typeof Bun.serve>;
  let root: string;
  let base: string;
  let released: Record<string, Uint8Array> = {};
  let releaseTag = "v9.9.9";

  /** Build a tarball containing a fake `slopenv-darwin-<arch>` that reports `version`. */
  function publish(version: string, arch: string, corrupt = false): void {
    const staging = join(root, `stage-${version}-${arch}`);
    mkdirSync(staging, { recursive: true });
    const name = `slopenv-darwin-${arch}`;
    writeFileSync(join(staging, name), `#!/bin/sh\necho "${version}"\n`, { mode: 0o755 });
    chmodSync(join(staging, name), 0o755);

    const tarball = join(root, `${name}.tar.gz`);
    Bun.spawnSync(["/usr/bin/tar", "czf", tarball, "-C", staging, name]);
    const bytes = new Uint8Array(readFileSync(tarball));
    released[`${name}.tar.gz`] = bytes;

    const digest = corrupt
      ? "0".repeat(64)
      : new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
    released.SHA256SUMS = new TextEncoder().encode(`${digest}  ${name}.tar.gz\n`);
  }

  beforeAll(() => {
    root = realpathSync(tempDir());
    server = Bun.serve({
      port: 0,
      fetch(request) {
        const path = new URL(request.url).pathname;
        if (path === "/latest") {
          return Response.json({
            tag_name: releaseTag,
            assets: Object.keys(released).map((name) => ({
              name,
              browser_download_url: `${base}/dl/${name}`,
            })),
          });
        }
        const file = released[path.replace("/dl/", "")];
        return file ? new Response(file) : new Response("not found", { status: 404 });
      },
    });
    base = `http://localhost:${server.port}`;
  });

  afterAll(() => {
    server.stop(true);
    cleanup(root);
  });

  function installedAt(dir: string, version: string): string {
    mkdirSync(dir, { recursive: true });
    const p = join(dir, "slopenv");
    writeFileSync(p, `#!/bin/sh\necho "${version}"\n`, { mode: 0o755 });
    chmodSync(p, 0o755);
    return p;
  }

  test("downloads, verifies and swaps in the new binary", async () => {
    released = {};
    releaseTag = "v9.9.9";
    publish("9.9.9", "arm64");
    const target = installedAt(join(root, "install-ok"), VERSION);
    const h = harness({ rulesPath: join(root, "rules.json"), cwd: root, env: {} });

    const code = await cmdUpdate([], h.ctx, {
      apiUrl: `${base}/latest`,
      execPath: target,
      platform: "darwin",
      arch: "arm64",
    });

    expect(code).toBe(0);
    expect(h.stdout()).toContain(`${VERSION} -> 9.9.9`);
    expect(readFileSync(target, "utf8")).toContain("9.9.9");
  }, 30_000);

  test("a corrupted download is refused and the working binary survives", async () => {
    released = {};
    releaseTag = "v9.9.9";
    publish("9.9.9", "arm64", true);
    const target = installedAt(join(root, "install-corrupt"), VERSION);
    const h = harness({ rulesPath: join(root, "rules.json"), cwd: root, env: {} });

    await expect(
      cmdUpdate([], h.ctx, { apiUrl: `${base}/latest`, execPath: target, platform: "darwin", arch: "arm64" }),
    ).rejects.toThrow(/checksum mismatch/);

    expect(readFileSync(target, "utf8")).toContain(VERSION);
  }, 30_000);

  test("a release with no SHA256SUMS is refused rather than installed unverified", async () => {
    released = {};
    releaseTag = "v9.9.9";
    publish("9.9.9", "arm64");
    delete released.SHA256SUMS;
    const target = installedAt(join(root, "install-nosums"), VERSION);
    const h = harness({ rulesPath: join(root, "rules.json"), cwd: root, env: {} });

    await expect(
      cmdUpdate([], h.ctx, { apiUrl: `${base}/latest`, execPath: target, platform: "darwin", arch: "arm64" }),
    ).rejects.toThrow(/no SHA256SUMS/);

    expect(readFileSync(target, "utf8")).toContain(VERSION);
  }, 30_000);

  test("a release with no build for this architecture is refused", async () => {
    released = {};
    releaseTag = "v9.9.9";
    publish("9.9.9", "arm64");
    const target = installedAt(join(root, "install-noarch"), VERSION);
    const h = harness({ rulesPath: join(root, "rules.json"), cwd: root, env: {} });

    await expect(
      cmdUpdate([], h.ctx, { apiUrl: `${base}/latest`, execPath: target, platform: "darwin", arch: "x64" }),
    ).rejects.toThrow(/no slopenv-darwin-x64/);
  }, 30_000);

  test("--check reports without touching anything", async () => {
    released = {};
    releaseTag = "v9.9.9";
    publish("9.9.9", "arm64");
    const target = installedAt(join(root, "install-check"), VERSION);
    const h = harness({ rulesPath: join(root, "rules.json"), cwd: root, env: {} });

    const code = await cmdUpdate(["--check"], h.ctx, {
      apiUrl: `${base}/latest`,
      execPath: target,
      platform: "darwin",
      arch: "arm64",
    });

    expect(code).toBe(0);
    expect(h.stdout()).toContain("9.9.9 is available");
    expect(readFileSync(target, "utf8")).toContain(VERSION);
  }, 30_000);

  test("says so when you are already current, and downloads nothing", async () => {
    released = {};
    publish("9.9.9", "arm64");
    releaseTag = `v${VERSION}`; // the published release is the one you have
    const target = installedAt(join(root, "install-current"), VERSION);
    const h = harness({ rulesPath: join(root, "rules.json"), cwd: root, env: {} });

    // Failing every download proves the early return happened before any.
    const code = await cmdUpdate([], h.ctx, {
      apiUrl: `${base}/latest`,
      execPath: target,
      platform: "darwin",
      arch: "arm64",
      fetchImpl: async (input, init) => {
        if (String(input).includes("/dl/")) throw new Error("should not have downloaded anything");
        return fetch(input, init);
      },
    });

    expect(code).toBe(0);
    expect(h.stdout()).toBe(`slopenv ${VERSION} is the latest release\n`);
    expect(readFileSync(target, "utf8")).toContain(VERSION);
  }, 30_000);

  test("--force reinstalls even when the versions match", async () => {
    released = {};
    publish(VERSION, "arm64");
    releaseTag = `v${VERSION}`;
    const target = installedAt(join(root, "install-force"), "0.0.0-stale");
    const h = harness({ rulesPath: join(root, "rules.json"), cwd: root, env: {} });

    const code = await cmdUpdate(["--force"], h.ctx, {
      apiUrl: `${base}/latest`,
      execPath: target,
      platform: "darwin",
      arch: "arm64",
    });

    expect(code).toBe(0);
    expect(readFileSync(target, "utf8")).toContain(VERSION);
  }, 30_000);

  test("an unreachable GitHub is a clear message, not a stack trace", async () => {
    const target = installedAt(join(root, "install-offline"), VERSION);
    const h = harness({ rulesPath: join(root, "rules.json"), cwd: root, env: {} });

    await expect(
      cmdUpdate([], h.ctx, {
        apiUrl: `${base}/latest`,
        execPath: target,
        platform: "darwin",
        arch: "arm64",
        fetchImpl: async () => {
          throw new Error("network is unreachable");
        },
      }),
    ).rejects.toThrow(/could not reach GitHub: network is unreachable/);
  }, 30_000);

  test("refuses to replace a build inside the repo", async () => {
    const dir = join(root, "repo");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "slopenv" }));
    const target = installedAt(dir, VERSION);
    const h = harness({ rulesPath: join(root, "rules.json"), cwd: root, env: {} });

    await expect(
      cmdUpdate([], h.ctx, { apiUrl: `${base}/latest`, execPath: target, platform: "darwin", arch: "arm64" }),
    ).rejects.toThrow(/local build inside the slopenv repo/);
  }, 30_000);
});
