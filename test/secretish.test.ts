import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { loadRules } from "../src/rules.ts";
import { detectSecretish } from "../src/secretish.ts";
import { shellQuote } from "../src/shell.ts";
import { cleanup, tempDir } from "./helpers.ts";

/**
 * A guard rail is only useful if it stays quiet. The "should not fire" block is
 * the more important half of this file: a check that cries wolf is one you learn
 * to dismiss without reading, and then it protects nothing.
 */

const CREDENTIALS: ReadonlyArray<readonly [string, string, string]> = [
  ["CLAUDE_CODE_OAUTH_TOKEN", "sk-ant-oat01-AbCdEf123456789012345678901234", "Anthropic OAuth token"],
  ["ANTHROPIC_API_KEY", "sk-ant-api03-AbCdEf123456789012345678901234", "Anthropic API key"],
  ["OPENAI_API_KEY", "sk-proj-AbCdEf1234567890abcdefghij", "OpenAI project key"],
  ["OPENAI_API_KEY", "sk-AbCdEf1234567890abcdefghijkl", "OpenAI-style secret key"],
  ["OPENROUTER_KEY", "sk-or-v1-abcdef1234567890", "OpenRouter key"],
  ["GH", "ghp_AbCdEf1234567890abcdefghij", "GitHub token"],
  ["GH", "gho_AbCdEf1234567890abcdefghij", "GitHub token"],
  ["GH", "github_pat_11ABCDEFG0abcdefghij", "GitHub fine-grained token"],
  ["GL", "glpat-AbCdEf1234567890", "GitLab personal access token"],
  ["SLACK", "xoxb-123456789012-1234567890123-AbCdEf", "Slack token"],
  ["SLACK_APP", "xapp-1-A012345-1234567890-abcdef", "Slack app-level token"],
  ["AWS", "AKIAIOSFODNN7EXAMPLE", "AWS access key ID"],
  ["AWS", "ASIAIOSFODNN7EXAMPLE", "AWS access key ID"],
  ["GOOGLE", "AIzaSyA1234567890abcdefghijklmnopqrstu", "Google API key"],
  ["GOOGLE", "ya29.a0AfH6SMBx1234567890", "Google OAuth token"],
  ["STRIPE", "sk_live_51AbCdEf1234567890", "Stripe secret key"],
  ["STRIPE", "rk_test_51AbCdEf1234567890", "Stripe secret key"],
  ["SENDGRID", "SG.AbCdEf1234567890.XyZ1234567890abcdef", "SendGrid API key"],
  ["NPM", "npm_AbCdEf1234567890abcdefghijklmnop", "npm token"],
  ["DO", "dop_v1_abcdef1234567890", "DigitalOcean token"],
  ["HF", "hf_AbCdEf1234567890abcdefghij", "Hugging Face token"],
  ["REPLICATE", "r8_AbCdEf1234567890abcdefghij", "Replicate token"],
  ["GROQ", "gsk_AbCdEf1234567890abcdefghij", "Groq API key"],
  ["SHOPIFY", "shpat_abcdef1234567890", "Shopify access token"],
  ["LINEAR", "lin_api_abcdef1234567890", "Linear API key"],
  ["FIGMA", "figd_AbCdEf1234567890", "Figma token"],
  ["SENTRY", "sntrys_abcdef1234567890", "Sentry token"],
  ["PYPI", "pypi-AgEIcHlwaS5vcmcAAgQ", "PyPI token"],
  ["JWT", "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVP", "JWT"],
  ["AUTHORIZATION", "Bearer abcdef1234567890ABCDEF", "bearer token"],
  ["PRIVATE", "-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXk=\n", "PEM private key"],
  ["PRIVATE", "-----BEGIN RSA PRIVATE KEY-----\nMIIEow==\n", "PEM private key"],
  ["DATABASE_URL", "postgres://admin:hunter2@db.example.com:5432/app", "URL with an embedded password"],
];

describe("credential shapes are caught regardless of the variable name", () => {
  for (const [name, value, expected] of CREDENTIALS) {
    test(expected, () => {
      const found = detectSecretish(name, value);
      expect(found?.confidence).toBe("high");
      expect(found?.what).toContain(expected);
    });
  }

  test("a harmless-looking name does not excuse a credential-shaped value", () => {
    expect(detectSecretish("GREETING", "sk-ant-api03-abcdefghijklmnopqrstuvwx")?.confidence).toBe("high");
    expect(detectSecretish("PORT", "ghp_AbCdEf1234567890abcdefghij")?.confidence).toBe("high");
  });
});

describe("secret-sounding names, with values that aren't obviously harmless", () => {
  const cases = [
    ["DATABASE_PASSWORD", "correct-horse-battery"],
    ["MY_APP_SECRET", "9f8a7b6c5d4e3f2a1b"],
    ["SOME_API_KEY", "abcdef1234567890abcdef"],
    ["SERVICE_TOKEN", "aVeryLongOpaqueTokenValue"],
    ["JWT_SIGNING_KEY", "s3cr3t-signing-material"],
    ["AWS_SECRET_ACCESS_KEY", "wJalrXUtnFEMI/K7MDENG/bPxRfiCY"],
    ["CLIENT_SECRET", "abc123def456ghi789"],
    ["AUTH_PASSWORD", "letmeinplease"],
  ] as const;

  for (const [name, value] of cases) {
    test(name, () => {
      expect(detectSecretish(name, value)?.confidence).toBe("medium");
    });
  }
});

describe("should not fire", () => {
  const quiet: ReadonlyArray<readonly [string, string]> = [
    // Ordinary configuration.
    ["NODE_ENV", "development"],
    ["PORT", "3000"],
    ["LOG_LEVEL", "debug"],
    ["AWS_REGION", "eu-north-1"],
    ["EDITOR", "nvim"],
    ["TZ", "Europe/Stockholm"],
    ["FULL_NAME", "Kristoffer Remback"],

    // Names that mention credentials without holding one.
    ["SSH_KEY_PATH", "~/.ssh/id_ed25519"],
    ["SECRET_FILE", "/etc/app/secret.json"],
    ["TOKEN_TTL", "3600"],
    ["AUTH_ENABLED", "true"],
    ["AUTH_URL", "https://auth.example.com/oauth/authorize"],
    ["API_KEY_HEADER", "X-Api-Key"],
    ["PUBLIC_KEY", "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAI"],
    ["JWT_ALGORITHM", "RS256"],
    ["TOKEN_ISSUER", "https://issuer.example.com"],
    ["SESSION_KEY_NAME", "sid"],
    ["PASSWORD_TYPE", "argon2id"],

    // A URL without credentials in it.
    ["DATABASE_URL", "postgres://db.example.com:5432/app"],
    ["REDIS_URL", "redis://localhost:6379"],

    // Short or plainly non-secret values under a secret-ish name.
    ["API_KEY", "none"],
    ["PASSWORD", "1234"],
    ["SECRET", "x"],
    ["APP_TOKEN", "dev"],
    ["MY_SECRET", "a shared phrase with spaces"],

    // Things that merely look like base64 or hex but aren't credentials.
    ["GIT_COMMIT", "3f2a91c4b7e8d5a6f0c1b2e3d4a5f6c7b8e9d0a1"],
    ["BUILD_ID", "20260727153045"],
  ];

  for (const [name, value] of quiet) {
    test(`${name}=${value.length > 28 ? `${value.slice(0, 28)}…` : value}`, () => {
      expect(detectSecretish(name, value)).toBe(null);
    });
  }
});

/**
 * The confirmation prompt, driven through a real pty.
 *
 * `script` allocates one, which is the only way to exercise the interactive
 * branch — under `bun test` stdin is a pipe, so slopenv takes the
 * refuse-rather-than-hang path instead. The answer is delayed deliberately: fed
 * before the prompt is written, a pty swallows it and the read sees EOF.
 */
describe("the confirmation prompt (real pty)", () => {
  const CLI = join(import.meta.dir, "..", "src", "cli.ts");
  let root: string;
  let rulesPath: string;
  let proj: string;

  beforeAll(() => {
    root = realpathSync(tempDir());
    rulesPath = join(root, "rules.json");
    proj = join(root, "proj");
    mkdirSync(proj, { recursive: true });
  });

  afterAll(() => cleanup(root));

  function answer(reply: string, args: string): string {
    const inner = `${shellQuote(process.execPath)} ${shellQuote(CLI)} ${args}`;
    const script = `( sleep 1.2; printf '${reply}\\n'; sleep 0.6 ) | script -q /dev/null ${inner} 2>&1`;
    const proc = Bun.spawnSync(["/bin/sh", "-c", script], {
      env: { ...process.env, SLOPENV_CONFIG: rulesPath },
      cwd: proj,
      stdout: "pipe",
      stderr: "pipe",
    });
    return proc.stdout.toString().replace(/\r/g, "");
  }

  function valueOf(name: string): string | undefined {
    return loadRules(rulesPath).rules.find((r) => r.name === name)?.value;
  }

  test("y stores the value", () => {
    const output = answer("y", "set STORED_KEY=sk-proj-AbCdEf1234567890abcdefghij");
    expect(output).toContain("looks like an OpenAI project key");
    expect(output).toContain("Store it in plain text anyway? [y/N]");
    expect(valueOf("STORED_KEY")).toBe("sk-proj-AbCdEf1234567890abcdefghij");
  }, 20_000);

  test("n aborts and writes nothing", () => {
    const output = answer("n", "set REFUSED_KEY=sk-proj-ZzZzZz1234567890abcdefghij");
    expect(output).toContain("aborted — nothing was written");
    expect(valueOf("REFUSED_KEY")).toBeUndefined();
  }, 20_000);

  test("just pressing return is a no — the default is the safe one", () => {
    const output = answer("", "set DEFAULTED_KEY=sk-proj-QqQqQq1234567890abcdefghij");
    expect(output).toContain("aborted — nothing was written");
    expect(valueOf("DEFAULTED_KEY")).toBeUndefined();
  }, 20_000);

  test("--yes skips the question entirely", () => {
    const output = answer("", "set SKIPPED_KEY=sk-proj-YyYyYy1234567890abcdefghij --yes");
    expect(output).not.toContain("Store it in plain text anyway?");
    expect(valueOf("SKIPPED_KEY")).toBe("sk-proj-YyYyYy1234567890abcdefghij");
  }, 20_000);
});
