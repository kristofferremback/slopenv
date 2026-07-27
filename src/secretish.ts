/**
 * Heuristics for "that looks like a credential, are you sure you want it in a
 * plain-text file?".
 *
 * This is a guard rail, not a scanner. It is tuned to be quiet: a false positive
 * costs you one keystroke (or `--yes`), but a *noisy* check is one you learn to
 * dismiss without reading, at which point it protects nothing.
 */

export type Confidence = "high" | "medium";

export interface Suspicion {
  confidence: Confidence;
  /** Reads as "... looks like <what>". */
  what: string;
}

/**
 * Value shapes that identify a credential on their own, regardless of what the
 * variable is called. Ordered most specific first — the first match wins.
 */
const CREDENTIAL_VALUES: ReadonlyArray<readonly [RegExp, string]> = [
  [/^-----BEGIN [A-Z ]*PRIVATE KEY-----/, "a PEM private key"],
  [/^sk-ant-api\d/, "an Anthropic API key"],
  [/^sk-ant-oat\d/, "an Anthropic OAuth token"],
  [/^sk-ant-/, "an Anthropic secret key"],
  [/^sk-proj-/, "an OpenAI project key"],
  [/^sk-or-v1-/, "an OpenRouter key"],
  [/^(sk|rk)_(live|test)_/, "a Stripe secret key"],
  [/^sk-[A-Za-z0-9]{16,}/, "an OpenAI-style secret key"],
  [/^gh[pousr]_[A-Za-z0-9]{16,}/, "a GitHub token"],
  [/^github_pat_/, "a GitHub fine-grained token"],
  [/^glpat-/, "a GitLab personal access token"],
  [/^xox[baprs]-/, "a Slack token"],
  [/^xapp-\d/, "a Slack app-level token"],
  [/^A(KIA|SIA)[0-9A-Z]{12,}/, "an AWS access key ID"],
  [/^AIza[0-9A-Za-z_-]{20,}/, "a Google API key"],
  [/^ya29\./, "a Google OAuth token"],
  [/^SG\.[A-Za-z0-9_-]{16,}/, "a SendGrid API key"],
  [/^npm_[A-Za-z0-9]{20,}/, "an npm token"],
  [/^dop_v1_/, "a DigitalOcean token"],
  [/^hf_[A-Za-z0-9]{20,}/, "a Hugging Face token"],
  [/^r8_[A-Za-z0-9]{20,}/, "a Replicate token"],
  [/^gsk_[A-Za-z0-9]{20,}/, "a Groq API key"],
  [/^shp(at|ss|ca)_/, "a Shopify access token"],
  [/^lin_api_/, "a Linear API key"],
  [/^figd_/, "a Figma token"],
  [/^sntry[su]_/, "a Sentry token"],
  [/^pypi-AgE/, "a PyPI token"],
  [/^eyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\./, "a JWT"],
  [/^Bearer\s+\S{16,}$/, "a bearer token"],
  // Not a prefix, but unmistakable, and the case DATABASE_URL would otherwise hide.
  [/^[a-z][a-z0-9+.-]*:\/\/[^/\s:@]+:[^/\s@]+@/i, "a URL with an embedded password"],
];

/** Names that suggest the value is a credential even when its shape doesn't. */
const SECRETISH_NAME =
  /(SECRET|PASSWORD|PASSWD|TOKEN|API_?KEY|PRIVATE_?KEY|ACCESS_?KEY|SIGNING_?KEY|SESSION_?KEY|CREDENTIAL|_AUTH$|^AUTH_)/;

/**
 * Names that merely *mention* a credential rather than holding one —
 * `SSH_KEY_PATH`, `AUTH_HEADER`, `TOKEN_TTL`, `PUBLIC_KEY`.
 */
const NAME_EXCEPTIONS =
  /(PUBLIC|_PATH$|_FILE$|_DIR$|_URL$|_URI$|_ID$|_NAME$|_HEADER$|_TYPE$|_TTL$|_EXPIRY$|_ALGORITHM$|_ENABLED$|_REQUIRED$|_ENDPOINT$|_ISSUER$|_AUDIENCE$)/;

/**
 * Values that plainly aren't credentials. Only consulted for the name-based rule —
 * a recognised credential shape is never explained away.
 */
function looksHarmless(value: string): boolean {
  if (value.length < 8) return true;
  if (/^(\.{0,2}\/|~\/)/.test(value)) return true; // a path
  if (/^\d+(\.\d+)*$/.test(value)) return true; // a number or version
  if (/^(true|false|yes|no|on|off|none|null|undefined)$/i.test(value)) return true;
  if (/\s/.test(value.trim())) return true; // prose, not a token
  return false;
}

/**
 * Does this name/value pair look like something that belongs in the keychain
 * rather than in a plain-text file? Null means "no reason to think so".
 */
export function detectSecretish(name: string, value: string): Suspicion | null {
  for (const [pattern, what] of CREDENTIAL_VALUES) {
    if (pattern.test(value)) return { confidence: "high", what };
  }

  if (SECRETISH_NAME.test(name) && !NAME_EXCEPTIONS.test(name) && !looksHarmless(value)) {
    return { confidence: "medium", what: "a credential, going by its name" };
  }

  return null;
}

/** The warning text, shared by `set` and `doctor`. */
export function describeSuspicion(name: string, suspicion: Suspicion): string {
  const lead = suspicion.confidence === "high" ? "that value looks like" : "that looks like";
  return `${name}: ${lead} ${suspicion.what}`;
}
