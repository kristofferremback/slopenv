import { rmSync } from "node:fs";
import { parseArgs } from "../args.ts";
import { VERSION } from "../version.ts";
import type { Context } from "../context.ts";
import { fail } from "../errors.ts";
import {
  assetNameFor,
  compareVersions,
  DEFAULT_RELEASE_API,
  downloadAsset,
  installBinary,
  parseRelease,
  updateBlocker,
  type FetchLike,
  type Release,
} from "../update.ts";

export interface UpdateDeps {
  /** Overridden in tests to point at a local server instead of GitHub. */
  apiUrl?: string;
  fetchImpl?: FetchLike;
  /** The binary to replace. Defaults to the running one. */
  execPath?: string;
  platform?: string;
  arch?: string;
}

async function fetchRelease(apiUrl: string, fetchImpl: FetchLike, ctx: Context): Promise<Release> {
  const headers: Record<string, string> = { Accept: "application/vnd.github+json" };
  // Unauthenticated GitHub allows 60 requests an hour per IP. Use a token when
  // the shell already has one, so a busy network does not turn into a failure.
  const token = ctx.env.GH_TOKEN || ctx.env.GITHUB_TOKEN;
  if (token) headers.Authorization = `Bearer ${token}`;

  let response: Response;
  try {
    response = await fetchImpl(apiUrl, { headers });
  } catch (err) {
    return fail(`could not reach GitHub: ${(err as Error).message}`);
  }

  if (response.status === 403 || response.status === 429) {
    fail("GitHub rate-limited the update check. Try again later, or set GH_TOKEN.");
  }
  if (!response.ok) fail(`GitHub returned HTTP ${response.status} for the latest release`);

  return parseRelease(await response.json());
}

/**
 * Update the installed binary from the latest GitHub release.
 *
 * The order matters: refuse early if this install is not ours to replace, verify
 * the download against the published checksum before unpacking it, and run the
 * new binary before overwriting the working one.
 */
export async function cmdUpdate(argv: readonly string[], ctx: Context, deps: UpdateDeps = {}): Promise<number> {
  const args = parseArgs(argv, { boolean: ["check", "force"] });
  if (args.positional.length > 0) fail("usage: slopenv update [--check] [--force]");

  const execPath = deps.execPath ?? process.execPath;
  const checkOnly = args.flags.has("check");

  // Even --check reports honestly about an install that could not be updated.
  const blocker = updateBlocker(execPath);
  if (blocker && !checkOnly) fail(blocker);

  const release = await fetchRelease(deps.apiUrl ?? DEFAULT_RELEASE_API, deps.fetchImpl ?? fetch, ctx);
  const latest = release.tag.replace(/^v/, "");
  const comparison = compareVersions(latest, VERSION);

  if (comparison <= 0 && !args.flags.has("force")) {
    ctx.out(
      comparison === 0
        ? `slopenv ${VERSION} is the latest release\n`
        : `slopenv ${VERSION} is newer than the latest release (${latest})\n`,
    );
    return 0;
  }

  if (checkOnly) {
    ctx.out(`slopenv ${latest} is available (you have ${VERSION})\n`);
    ctx.out(`  update with: slopenv update\n`);
    if (blocker) ctx.err(`slopenv: ${blocker}\n`);
    return 0;
  }

  const assetName = assetNameFor(deps.platform ?? process.platform, deps.arch ?? process.arch);
  const asset = release.assets.find((a) => a.name === assetName);
  const sums = release.assets.find((a) => a.name === "SHA256SUMS");
  if (!asset) fail(`release ${release.tag} has no ${assetName}`);
  if (!sums) fail(`release ${release.tag} has no SHA256SUMS, so the download cannot be verified`);

  ctx.err(`slopenv: downloading ${assetName} from ${release.tag}\n`);
  const downloaded = await downloadAsset(asset, sums, deps.fetchImpl ?? fetch);

  try {
    installBinary({ targetPath: execPath, stagedPath: downloaded.path, expectedVersion: latest });
  } finally {
    rmSync(downloaded.workdir, { recursive: true, force: true });
  }

  ctx.out(`updated ${execPath}: ${VERSION} -> ${latest}\n`);
  ctx.out(`open a new shell, or run  eval "$(slopenv hook zsh)"  to pick it up\n`);
  return 0;
}
