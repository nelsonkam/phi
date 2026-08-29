import { expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, sep } from "node:path";
import { tempDir } from "@/testing/tmpdir";
import { loadWorkspaceMcpConfig } from "../mcp-config";

function writeConfig(value: unknown): string {
  const root = tempDir();
  mkdirSync(join(root, ".agents"), { recursive: true });
  writeFileSync(join(root, ".agents", "mcp.json"), JSON.stringify(value));
  return root;
}

test("an absent MCP config produces no workspace servers", async () => {
  expect(await loadWorkspaceMcpConfig(tempDir(), {})).toEqual({
    servers: [],
    fingerprint: "absent",
    sandboxGateway: false,
  });
});

const GATEWAY_ENV = {
  PHI_IN_SANDBOX: "1",
  MCP_GATEWAY_URL: "http://127.0.0.1:8811/mcp",
  MCP_SENTINEL_TOKEN_NAME: "sbx-mcp-sentinel-1",
};

test("registers the sandbox MCP gateway from the sandbox environment", async () => {
  const result = await loadWorkspaceMcpConfig(tempDir(), GATEWAY_ENV);
  expect(result.sandboxGateway).toBe(true);
  expect(result.servers).toEqual([
    {
      type: "http",
      name: "sbx",
      url: "http://127.0.0.1:8811/mcp",
      headers: [
        { name: "Authorization", value: "Bearer sbx-mcp-sentinel-1" },
      ],
    },
  ]);
  expect(result.fingerprint).toHaveLength(64);

  const withoutGateway = await loadWorkspaceMcpConfig(tempDir(), {
    ...GATEWAY_ENV,
    MCP_GATEWAY_URL: undefined,
  });
  expect(withoutGateway.sandboxGateway).toBe(false);
  expect(withoutGateway.servers).toEqual([]);
  expect(withoutGateway.fingerprint).not.toBe(result.fingerprint);
});

test("requires the sandbox marker before registering the gateway", async () => {
  const result = await loadWorkspaceMcpConfig(tempDir(), {
    ...GATEWAY_ENV,
    PHI_IN_SANDBOX: undefined,
  });
  expect(result.sandboxGateway).toBe(false);
  expect(result.servers).toEqual([]);
});

test("a user-configured sbx server overrides the sandbox gateway", async () => {
  const root = writeConfig({
    mcpServers: {
      sbx: { url: "https://example.com/other-gateway" },
    },
  });
  const result = await loadWorkspaceMcpConfig(root, GATEWAY_ENV);
  expect(result.sandboxGateway).toBe(false);
  expect(result.servers).toEqual([
    {
      type: "http",
      name: "sbx",
      url: "https://example.com/other-gateway",
      headers: [],
    },
  ]);
});

test("a disabled user sbx server disables automatic registration", async () => {
  const root = writeConfig({
    mcpServers: {
      sbx: { url: "https://example.com/other-gateway", disabled: true },
    },
  });
  const result = await loadWorkspaceMcpConfig(root, GATEWAY_ENV);
  expect(result.sandboxGateway).toBe(false);
  expect(result.servers).toEqual([]);
});

test("loads Cursor-style HTTP and stdio servers without type", async () => {
  const envPath = Bun.which("env");
  expect(envPath).toBeTruthy();
  const root = writeConfig({
    mcpServers: {
      github: {
        url: "https://example.com/mcp",
        headers: {
          Authorization: "Bearer ${env:TEST_MCP_TOKEN}",
          "X-Client": "phi",
        },
      },
      local: {
        command: "env",
        args: ["node", "${workspaceFolder}/server.js"],
        env: { API_KEY: "${env:TEST_MCP_TOKEN}" },
      },
    },
  });

  const result = await loadWorkspaceMcpConfig(root, {
    TEST_MCP_TOKEN: "secret-value",
  });
  expect(result.servers).toEqual([
    {
      type: "http",
      name: "github",
      url: "https://example.com/mcp",
      headers: [
        { name: "Authorization", value: "Bearer secret-value" },
        { name: "X-Client", value: "phi" },
      ],
    },
    {
      name: "local",
      command: envPath!,
      args: ["node", join(root, "server.js")],
      env: [{ name: "API_KEY", value: "secret-value" }],
    },
  ]);
  expect(result.fingerprint).toHaveLength(64);

  const rotated = await loadWorkspaceMcpConfig(root, {
    TEST_MCP_TOKEN: "rotated-secret",
  });
  expect(rotated.fingerprint).not.toBe(result.fingerprint);
});

test("resolves Claude-style ${VAR} interpolation and path placeholders", async () => {
  const root = writeConfig({
    mcpServers: {
      remote: {
        type: "http",
        url: "https://example.com/${workspaceFolderBasename}",
        headers: {
          Authorization: "Bearer ${CLAUDE_TOKEN}",
          Home: "${userHome}",
          Sep: "${pathSeparator}${/}",
        },
      },
    },
  });

  const result = await loadWorkspaceMcpConfig(root, {
    CLAUDE_TOKEN: "claude-secret",
  });
  expect(result.servers).toEqual([
    {
      type: "http",
      name: "remote",
      url: `https://example.com/${basename(root)}`,
      headers: [
        { name: "Authorization", value: "Bearer claude-secret" },
        { name: "Home", value: homedir() },
        { name: "Sep", value: `${sep}${sep}` },
      ],
    },
  ]);
});

test("skips disabled servers and keeps absolute commands", async () => {
  const root = writeConfig({
    mcpServers: {
      off: {
        url: "https://example.com/off",
        disabled: true,
      },
      local: {
        type: "stdio",
        command: "/usr/bin/env",
        args: ["node", "server.js"],
      },
    },
  });

  const result = await loadWorkspaceMcpConfig(root);
  expect(result.servers).toEqual([
    {
      name: "local",
      command: "/usr/bin/env",
      args: ["node", "server.js"],
      env: [],
    },
  ]);
});

test("missing environment variables are named without leaking other values", async () => {
  const root = writeConfig({
    mcpServers: {
      remote: {
        url: "https://example.com/mcp",
        headers: { Authorization: "Bearer ${env:MISSING_MCP_TOKEN}" },
      },
    },
  });

  await expect(
    loadWorkspaceMcpConfig(root, { OTHER: "do-not-print" }),
  ).rejects.toThrow(
    'mcpServers.remote.headers.Authorization: environment variable "MISSING_MCP_TOKEN" is not set',
  );
  await loadWorkspaceMcpConfig(root, { OTHER: "do-not-print" }).catch(
    (error) => {
      expect(String(error)).not.toContain("do-not-print");
    },
  );
});

test("malformed JSON errors do not echo source contents", async () => {
  const root = tempDir();
  mkdirSync(join(root, ".agents"), { recursive: true });
  writeFileSync(
    join(root, ".agents", "mcp.json"),
    '{"mcpServers":{"token":"literal-secret",',
  );

  await loadWorkspaceMcpConfig(root).catch((error) => {
    expect(String(error)).toContain("could not parse JSON");
    expect(String(error)).not.toContain("literal-secret");
  });
});

test("rejects reserved names, unknown commands, and unknown properties", async () => {
  const reserved = writeConfig({
    mcpServers: {
      phi: { url: "https://example.com" },
    },
  });
  await expect(loadWorkspaceMcpConfig(reserved)).rejects.toThrow(
    '"phi" is reserved',
  );

  const cased = writeConfig({
    mcpServers: {
      PHI: { url: "https://example.com" },
    },
  });
  await expect(loadWorkspaceMcpConfig(cased)).rejects.toThrow(
    '"phi" is reserved',
  );

  const missing = writeConfig({
    mcpServers: {
      local: { command: "phi-mcp-server-not-on-path" },
    },
  });
  await expect(loadWorkspaceMcpConfig(missing)).rejects.toThrow(
    "mcpServers.local.command: command was not found on PATH",
  );

  const extra = writeConfig({
    mcpServers: {
      remote: {
        url: "https://example.com",
        token: "plaintext",
      },
    },
  });
  await expect(loadWorkspaceMcpConfig(extra)).rejects.toThrow(
    "Unrecognized key",
  );
});

test("rejects { fromEnv } objects in favor of ${env:NAME}", async () => {
  const root = writeConfig({
    mcpServers: {
      remote: {
        url: "https://example.com/mcp",
        headers: { Authorization: { fromEnv: "GITHUB_TOKEN" } },
      },
    },
  });
  await expect(loadWorkspaceMcpConfig(root)).rejects.toThrow(
    "${env:NAME}",
  );
});

test("rejects mixed transports and unsupported envFile", async () => {
  const mixed = writeConfig({
    mcpServers: {
      both: {
        command: "env",
        url: "https://example.com/mcp",
      },
    },
  });
  await expect(loadWorkspaceMcpConfig(mixed)).rejects.toThrow(
    "must set either command or url, not both",
  );

  const envFile = writeConfig({
    mcpServers: {
      local: {
        command: "env",
        envFile: ".env",
      },
    },
  });
  await expect(loadWorkspaceMcpConfig(envFile)).rejects.toThrow(
    "Unrecognized key",
  );
});

test("rejects duplicate server names and cleartext interpolated headers", async () => {
  const root = tempDir();
  mkdirSync(join(root, ".agents"), { recursive: true });
  writeFileSync(
    join(root, ".agents", "mcp.json"),
    '{"mcpServers":{"dup":{"url":"https://example.com/a"},"dup":{"url":"https://example.com/b"}}}',
  );
  await expect(loadWorkspaceMcpConfig(root)).rejects.toThrow(
    "mcpServers.dup: duplicate server name",
  );

  const cleartext = writeConfig({
    mcpServers: {
      remote: {
        url: "http://example.com/mcp",
        headers: { Authorization: "Bearer ${env:TEST_MCP_TOKEN}" },
      },
    },
  });
  await expect(
    loadWorkspaceMcpConfig(cleartext, { TEST_MCP_TOKEN: "secret-value" }),
  ).rejects.toThrow("interpolated headers require https://");
  await loadWorkspaceMcpConfig(cleartext, { TEST_MCP_TOKEN: "secret-value" }).catch(
    (error) => {
      expect(String(error)).not.toContain("secret-value");
    },
  );

  const loopback = writeConfig({
    mcpServers: {
      local: {
        url: "http://localhost:3000/mcp",
        headers: { Authorization: "Bearer ${env:TEST_MCP_TOKEN}" },
      },
    },
  });
  const result = await loadWorkspaceMcpConfig(loopback, {
    TEST_MCP_TOKEN: "secret-value",
  });
  expect(result.servers[0]).toMatchObject({
    type: "http",
    name: "local",
    url: "http://localhost:3000/mcp",
  });
});
