import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const roots: string[] = [];
const script = resolve(import.meta.dir, "../../../scripts/configure-sandbox-auth.mjs");

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function configure(modes: { anthropic: string; openai: string }) {
  const home = mkdtempSync(join(tmpdir(), "phi-sandbox-auth-"));
  roots.push(home);
  const child = Bun.spawn([process.execPath, script, "all"], {
    env: {
      ...process.env,
      HOME: home,
      CODEX_HOME: join(home, ".codex"),
      SBX_CRED_ANTHROPIC_MODE: modes.anthropic,
      SBX_CRED_OPENAI_MODE: modes.openai,
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

test("OAuth mode writes only proxy sentinels and placeholders", async () => {
  const home = await configure({ anthropic: "oauth", openai: "oauth" });
  const claude = JSON.parse(readFileSync(join(home, ".claude/settings.json"), "utf8"));
  const codex = readFileSync(join(home, ".codex/config.toml"), "utf8");
  const auth = readFileSync(join(home, ".codex/auth.json"), "utf8");

  expect(claude.apiKeyHelper).toBe("echo proxy-managed");
  expect(codex).toContain('model_provider = "sandboxd"');
  expect(codex).toContain('base_url = "https://chatgpt.com/backend-api/codex"');
  expect(codex).toContain('experimental_bearer_token = "oai-oat01-proxy-managed"');
  expect(auth).toBe('{"OPENAI_API_KEY":"proxy-managed"}\n');
});

test("none mode removes stale managed authentication", async () => {
  const home = await configure({ anthropic: "oauth", openai: "oauth" });
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
  expect(claude).toEqual({ theme: "dark" });
  expect(codex).not.toContain("sandboxd");
  expect(() => readFileSync(join(home, ".codex/auth.json"))).toThrow();
});

test("root kit owns complete OAuth contracts", () => {
  const root = readFileSync(resolve(import.meta.dir, "../../../docker/sandbox/phi/spec.yaml"), "utf8");
  expect(root).toContain("sk-ant-oat01-proxy-managed");
  expect(root).toContain("oai-oat01-proxy-managed");
  expect(root).toContain("cursor-oat-proxy-managed");
  expect(root).toContain("useHttp1ForAgent");
  expect(root).not.toContain("internal-ca");
  expect(root.match(/required: false/g)).toHaveLength(3);
  expect(root).not.toContain("required: true");
  expect(root).not.toContain("apiKey:");
  expect(root).toContain("CURSOR_AUTH_TOKEN: cursor-oat-proxy-managed");
});

test("sandbox startup reapplies OAuth modes acquired after creation", () => {
  const entrypoint = readFileSync(
    resolve(import.meta.dir, "../../../scripts/phi-sandbox-entrypoint"),
    "utf8",
  );
  expect(entrypoint).toContain("/usr/local/bin/configure-sandbox-auth all");
  expect(entrypoint.indexOf("configure-sandbox-auth")).toBeLessThan(
    entrypoint.indexOf("exec /usr/local/bin/phi serve"),
  );
});
