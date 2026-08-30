import { mkdirSync } from "node:fs";
import { phiRoot } from "@/core/paths";
import { DeviceAuth } from "@/server/device-auth";
import type { CliOutput } from "@/cli";

const pairHelp = `Usage: phi pair --server <url> [--name <name>]

Print the server's durable device token and a secret-free link that opens the
Phi macOS Add Server form. Paste the printed token into that form.

Options:
  --server <url>  Public HTTPS origin, or an HTTP loopback/forwarded origin
  --name <name>   Optional saved-server name (defaults to the hostname)
  -h, --help      Show this help message
`;

export interface PairCommandOptions {
  root?: string;
}

export function runPair(
  output: CliOutput,
  args: readonly string[],
  options: PairCommandOptions = {},
): number {
  if (args.includes("-h") || args.includes("--help")) {
    output.stdout(pairHelp);
    return 0;
  }

  let server: string | undefined;
  let name: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--server" || argument === "--name") {
      const value = args[index + 1]?.trim();
      if (!value || value.startsWith("--")) {
        throw new Error(`${argument} requires a value`);
      }
      if (argument === "--server") server = value;
      else name = value;
      index += 1;
      continue;
    }
    throw new Error(`unknown argument: ${argument}`);
  }

  if (!server) throw new Error("--server is required");
  const origin = normalizeServerOrigin(server);
  const savedName = name || origin.hostname;
  const root = options.root ?? phiRoot();
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const token = new DeviceAuth(root).localToken;
  const deepLink = new URL("phi://add-server");
  deepLink.searchParams.set("origin", origin.href);
  deepLink.searchParams.set("name", savedName);

  output.stdout(
    [
      "Phi device token:",
      token,
      "",
      "Open Phi for macOS:",
      deepLink.href,
      "",
      "The link does not contain the token. Paste the token into Add Server.",
      "",
    ].join("\n"),
  );
  return 0;
}

export function normalizeServerOrigin(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("--server must be an absolute http(s) URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("--server must use http or https");
  }
  if (url.username || url.password) {
    throw new Error("--server must not contain credentials");
  }
  if (url.pathname !== "/" || url.search || url.hash) {
    throw new Error("--server must be an origin without a path, query, or fragment");
  }
  if (url.protocol !== "https:" && !isLoopbackHost(url.hostname)) {
    throw new Error("non-loopback servers require https");
  }
  return new URL(url.origin);
}

function isLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost" || host === "::1") return true;
  const parts = host.split(".");
  return parts.length === 4 && parts[0] === "127"
    && parts.every((part) => /^\d{1,3}$/.test(part));
}
