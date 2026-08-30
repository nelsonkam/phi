import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const roots: string[] = [];
const script = resolve(import.meta.dir, "../../../scripts/configure-sandbox-auth.mjs");

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function configure(options: { anthropicApiKey?: string; openaiApiKey?: string } = {}) {
  const home = mkdtempSync(join(tmpdir(), "phi-sandbox-auth-"));
  roots.push(home);
  const child = Bun.spawn([process.execPath, script, "all"], {
    env: {
      ...process.env,
      HOME: home,
      CODEX_HOME: join(home, ".codex"),
      SBX_CRED_ANTHROPIC_MODE: "none",
      SBX_CRED_OPENAI_MODE: "none",
      ANTHROPIC_API_KEY: options.anthropicApiKey,
      OPENAI_API_KEY: options.openaiApiKey,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stderr] = await Promise.all([
    child.exited,
    new Response(child.stderr).text(),
  ]);
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
  return home;
}

test("OAuth setup writes only proxy sentinels without an OpenAI mode flag", async () => {
  const home = await configure();
  const claude = JSON.parse(readFileSync(join(home, ".claude/settings.json"), "utf8"));
  const codex = readFileSync(join(home, ".codex/config.toml"), "utf8");
  const auth = readFileSync(join(home, ".codex/auth.json"), "utf8");

  expect(claude.apiKeyHelper).toBe("echo proxy-managed");
  expect(codex).toContain('model_provider = "sandboxd"');
  expect(codex).toContain('base_url = "https://chatgpt.com/backend-api/codex"');
  expect(codex).toContain('experimental_bearer_token = "oai-oat01-proxy-managed"');
  expect(auth).toBe('{"OPENAI_API_KEY":"proxy-managed"}\n');
});

test("provider mode flags do not disable proxy-managed authentication", async () => {
  const home = await configure();
  const claudePath = join(home, ".claude/settings.json");
  writeFileSync(claudePath, '{"apiKeyHelper":"echo proxy-managed","theme":"dark"}\n');

  const child = Bun.spawn([process.execPath, script, "all"], {
    env: {
      ...process.env,
      HOME: home,
      CODEX_HOME: join(home, ".codex"),
      SBX_CRED_ANTHROPIC_MODE: "none",
      SBX_CRED_OPENAI_MODE: "none",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(await child.exited).toBe(0);

  const claude = JSON.parse(readFileSync(claudePath, "utf8"));
  const codex = readFileSync(join(home, ".codex/config.toml"), "utf8");
  expect(claude).toEqual({ apiKeyHelper: "echo proxy-managed", theme: "dark" });
  expect(codex).toContain('model_provider = "sandboxd"');
  expect(readFileSync(join(home, ".codex/auth.json"), "utf8")).toBe(
    '{"OPENAI_API_KEY":"proxy-managed"}\n',
  );
});

test("custom API keys select the CLIs' normal providers", async () => {
  const home = await configure({
    anthropicApiKey: "sbx-cs-anthropic-placeholder",
    openaiApiKey: "sbx-cs-placeholder",
  });
  const claude = JSON.parse(readFileSync(join(home, ".claude/settings.json"), "utf8"));
  const codex = readFileSync(join(home, ".codex/config.toml"), "utf8");

  expect(claude.apiKeyHelper).toBeUndefined();
  expect(codex).not.toContain("sandboxd");
  expect(codex).not.toContain("sbx-cs-placeholder");
  expect(() => readFileSync(join(home, ".codex/auth.json"))).toThrow();
});

test("root kit owns supported OAuth contracts and Cursor proxy settings", () => {
  const root = readFileSync(resolve(import.meta.dir, "../../../docker/sandbox/phi/spec.yaml"), "utf8");
  expect(root).toContain("sk-ant-oat01-proxy-managed");
  expect(root).toContain("oai-oat01-proxy-managed");
  expect(root).toContain("useHttp1ForAgent");
  expect(root).toContain("AGENT_CLI_CREDENTIAL_STORE: memory");
  expect(root).not.toContain("internal-ca");
  expect(root.match(/required: false/g)).toHaveLength(2);
  expect(root).not.toContain("required: true");
  expect(root).not.toContain("apiKey:");
  expect(root).not.toContain("service: cursor");
  expect(root).not.toContain("cursor-oat-proxy-managed");
  expect(root).not.toContain("CURSOR_AUTH_TOKEN");
});

test("sandbox startup reapplies proxy-managed authentication", () => {
  const entrypoint = readFileSync(
    resolve(import.meta.dir, "../../../scripts/phi-sandbox-entrypoint"),
    "utf8",
  );
  expect(entrypoint).toContain("/usr/local/bin/configure-sandbox-auth all");
  expect(entrypoint.indexOf("configure-sandbox-auth")).toBeLessThan(
    entrypoint.indexOf("exec /usr/local/bin/phi serve"),
  );
});
