#!/usr/bin/env node

import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const home = process.env.HOME || "/home/agent";

function ensureDirectory(path) {
  mkdirSync(path, { recursive: true });
}

function writePrivate(path, contents) {
  writeFileSync(path, contents, { mode: 0o600 });
  chmodSync(path, 0o600);
}

function readJson(path) {
  if (!existsSync(path)) return {};
  return JSON.parse(readFileSync(path, "utf8"));
}

function configureClaude() {
  const directory = join(home, ".claude");
  const path = join(directory, "settings.json");
  const settings = readJson(path);
  const mode = process.env.SBX_CRED_ANTHROPIC_MODE || "none";
  if (mode === "none") {
    if (settings.apiKeyHelper === "echo proxy-managed") delete settings.apiKeyHelper;
  } else {
    settings.apiKeyHelper = "echo proxy-managed";
  }
  ensureDirectory(directory);
  writePrivate(path, `${JSON.stringify(settings, null, 2)}\n`);
}

function configureCodex() {
  const directory = process.env.CODEX_HOME || join(home, ".codex");
  const configPath = join(directory, "config.toml");
  const authPath = join(directory, "auth.json");
  const mode = process.env.SBX_CRED_OPENAI_MODE || "none";
  const lines = [
    'approval_policy = "never"',
    'sandbox_mode = "danger-full-access"',
    'mcp_oauth_credentials_store = "file"',
  ];

  if (mode === "oauth" || mode === "apikey" || mode === "api-key") {
    lines.push('forced_login_method = "api"');
  }
  if (mode === "oauth") {
    lines.push(
      'model_provider = "sandboxd"',
      "",
      "[model_providers.sandboxd]",
      'name = "Sandbox Proxy"',
      'base_url = "https://chatgpt.com/backend-api/codex"',
      'experimental_bearer_token = "oai-oat01-proxy-managed"',
      "requires_openai_auth = false",
    );
  }

  ensureDirectory(directory);
  writePrivate(configPath, `${lines.join("\n")}\n`);
  if (mode === "oauth" || mode === "apikey" || mode === "api-key") {
    writePrivate(authPath, '{"OPENAI_API_KEY":"proxy-managed"}\n');
  } else {
    rmSync(authPath, { force: true });
  }
}

const provider = process.argv[2] || "all";
if (provider === "all" || provider === "claude") configureClaude();
if (provider === "all" || provider === "codex") configureCodex();
if (!["all", "claude", "codex"].includes(provider)) {
  throw new Error(`unknown sandbox auth provider: ${provider}`);
}
