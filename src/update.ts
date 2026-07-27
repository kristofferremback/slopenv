import { chmodSync, copyFileSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, unlinkSync } from "node:fs";
import { accessSync, constants, existsSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fail } from "./errors.ts";
import { debug } from "./log.ts";

export const DEFAULT_RELEASE_API = "https://api.github.com/repos/kristofferremback/slopenv/releases/latest";

/**
 * Just enough of `fetch` to download a release. Narrower than `typeof fetch` so
 * a test can substitute a plain function without implementing the whole thing.
 */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface ReleaseAsset {
  name: string;
  url: string;
}

export interface Release {
  /** Tag as published, e.g. `v0.1.2`. */
  tag: string;
  assets: ReleaseAsset[];
}

/** Asset published for a platform and architecture. */
export function assetNameFor(platform: string, arch: string): string {
  if (platform !== "darwin") {
    fail(`no build for this platform (${platform}); slopenv only ships macOS binaries`);
  }
  if (arch !== "arm64" && arch !== "x64") {
    fail(`no build for this architecture (${arch}); slopenv ships arm64 and x64`);
  }
  return `slopenv-darwin-${arch}.tar.gz`;
}

/** Numeric compare of `x.y.z`, ignoring a leading `v`. Returns >0 if a is newer. */
export function compareVersions(a: string, b: string): number {
  const parts = (v: string) => v.replace(/^v/, "").split(".").map((n) => Number.parseInt(n, 10) || 0);
  const [x, y] = [parts(a), parts(b)];
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const diff = (x[i] ?? 0) - (y[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/**
 * Pull the checksum for one file out of a `shasum -a 256` listing.
 * Returns null rather than guessing, because an unverifiable download is one we
 * refuse to install.
 */
export function checksumFor(sums: string, filename: string): string | null {
  for (const line of sums.split("\n")) {
    const match = /^([0-9a-f]{64})\s+\*?(.+?)\s*$/i.exec(line);
    if (match && basename(match[2] as string) === filename) return (match[1] as string).toLowerCase();
  }
  return null;
}

export function parseRelease(json: unknown): Release {
  if (typeof json !== "object" || json === null) fail("unexpected response from the GitHub releases API");
  const obj = json as Record<string, unknown>;

  const tag = obj.tag_name;
  if (typeof tag !== "string") fail("the GitHub releases API returned no tag_name");
  if (!Array.isArray(obj.assets)) fail("the GitHub releases API returned no assets");

  const assets: ReleaseAsset[] = [];
  for (const raw of obj.assets as unknown[]) {
    if (typeof raw !== "object" || raw === null) continue;
    const asset = raw as Record<string, unknown>;
    if (typeof asset.name === "string" && typeof asset.browser_download_url === "string") {
      assets.push({ name: asset.name, url: asset.browser_download_url });
    }
  }
  return { tag, assets };
}

/**
 * Why this install cannot update itself, or null if it can.
 *
 * A `bun run` invocation and a symlink into a checkout are both perfectly normal
 * ways to have slopenv on your PATH, and overwriting either would destroy
 * something the package manager or the repo owns.
 */
export function updateBlocker(execPath: string): string | null {
  const name = basename(execPath);
  if (name === "bun" || name === "bun-debug") {
    return "slopenv is running from source under bun, so there is no binary to replace. Update with: git pull && bun run build";
  }

  // `bun build --compile` output sits next to the package.json it was built from.
  const sibling = join(dirname(execPath), "package.json");
  if (existsSync(sibling)) {
    try {
      const pkg = JSON.parse(readFileSync(sibling, "utf8")) as { name?: string };
      if (pkg.name === "slopenv") {
        return `${execPath} is a local build inside the slopenv repo. Update it with: git pull && bun run build`;
      }
    } catch {
      // Not a readable package.json; treat the binary as a normal install.
    }
  }

  try {
    accessSync(dirname(execPath), constants.W_OK);
  } catch {
    return `${dirname(execPath)} is not writable, so the binary cannot be replaced. Reinstall from a release, or move slopenv somewhere you own.`;
  }

  return null;
}

export interface InstallOptions {
  /** The binary to replace. */
  targetPath: string;
  /** Downloaded, already checksum-verified replacement. */
  stagedPath: string;
  /** What the new binary must report from `--version`. */
  expectedVersion: string;
}

/**
 * Put the new binary in place.
 *
 * Two things matter. The replacement is verified by running it before anything
 * is overwritten, so a truncated or wrong-architecture download fails while the
 * working binary is still installed. And the swap is a `rename` within the
 * target's own directory, which is atomic, so there is no moment where the
 * binary on your PATH is half-written.
 */
export function installBinary(options: InstallOptions): void {
  const { targetPath, stagedPath, expectedVersion } = options;

  chmodSync(stagedPath, 0o755);

  const probe = Bun.spawnSync([stagedPath, "--version"], { stdout: "pipe", stderr: "pipe" });
  const reported = probe.stdout.toString().trim();
  if (probe.exitCode !== 0) {
    fail(`the downloaded binary does not run (exit ${probe.exitCode}); keeping the one you have`);
  }
  if (compareVersions(reported, expectedVersion) !== 0) {
    fail(
      `the downloaded binary reports ${JSON.stringify(reported)} but the release says ${JSON.stringify(expectedVersion)}; keeping the one you have`,
    );
  }

  // Staging inside the target's directory keeps the rename on one filesystem.
  const staging = join(dirname(targetPath), `.${basename(targetPath)}.update.${process.pid}`);
  try {
    copyFileSync(stagedPath, staging);
    chmodSync(staging, 0o755);
    renameSync(staging, targetPath);
  } catch (err) {
    try {
      unlinkSync(staging);
    } catch {
      /* nothing staged */
    }
    throw err;
  }

  debug(`replaced ${targetPath} with ${expectedVersion}`);
}

export interface DownloadResult {
  /** Extracted binary, verified against the published checksum. */
  path: string;
  /** Temp directory the caller must clean up. */
  workdir: string;
}

/**
 * Fetch the release asset and its checksum, verify, and extract.
 * Throws before extracting anything if the checksum does not match.
 */
export async function downloadAsset(
  asset: ReleaseAsset,
  sumsAsset: ReleaseAsset,
  fetchImpl: FetchLike = fetch,
): Promise<DownloadResult> {
  const workdir = mkdtempSync(join(tmpdir(), "slopenv-update-"));

  try {
    const sumsResponse = await fetchImpl(sumsAsset.url);
    if (!sumsResponse.ok) fail(`could not download ${sumsAsset.name} (HTTP ${sumsResponse.status})`);
    const expected = checksumFor(await sumsResponse.text(), asset.name);
    if (!expected) fail(`${sumsAsset.name} has no checksum for ${asset.name}; refusing to install it unverified`);

    const assetResponse = await fetchImpl(asset.url);
    if (!assetResponse.ok) fail(`could not download ${asset.name} (HTTP ${assetResponse.status})`);
    const bytes = new Uint8Array(await assetResponse.arrayBuffer());

    const actual = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
    if (actual !== expected) {
      fail(`checksum mismatch for ${asset.name}\n  expected ${expected}\n  got      ${actual}`);
    }

    const tarball = join(workdir, asset.name);
    await Bun.write(tarball, bytes);

    const tar = Bun.spawnSync(["/usr/bin/tar", "xzf", tarball, "-C", workdir], { stderr: "pipe" });
    if (tar.exitCode !== 0) fail(`could not unpack ${asset.name}: ${tar.stderr.toString().trim()}`);

    const extracted = join(workdir, asset.name.replace(/\.tar\.gz$/, ""));
    if (!existsSync(extracted)) fail(`${asset.name} did not contain ${basename(extracted)}`);
    if (!statSync(extracted).isFile()) fail(`${basename(extracted)} in ${asset.name} is not a file`);

    return { path: extracted, workdir };
  } catch (err) {
    rmSync(workdir, { recursive: true, force: true });
    throw err;
  }
}
