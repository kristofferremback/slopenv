import pkg from "../package.json";

/**
 * Single source of truth. The release workflow checks this against the git tag,
 * and `slopenv update` compares it to the latest published release.
 */
export const VERSION: string = pkg.version;
