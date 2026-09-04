import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import {
  basename,
  isAbsolute,
  join,
  resolve as resolvePath,
  sep,
} from "node:path";
import type { McpServer } from "@agentclientprotocol/sdk";
import { z } from "zod";

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const SERVER_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
const INTERPOLATION = /\$\{([^}]+)\}/g;
const configString = z.string({
  error:
    'must be a string; use "${env:NAME}" for secrets, not { "fromEnv": "NAME" }',
});

const serverSchema = z
  .object({
    type: z.enum(["stdio", "http", "sse"]).optional(),
    command: z.string().min(1).optional(),
    args: z.array(z.string()).optional(),
    env: z.record(z.string(), configString).optional(),
    url: z.string().min(1).optional(),
    headers: z.record(z.string(), configString).optional(),
    disabled: z.boolean().optional(),
  })
  .strict()
  .superRefine((server, ctx) => {
    const hasCommand = server.command !== undefined;
    const hasUrl = server.url !== undefined;
    if (hasCommand && hasUrl) {
      ctx.addIssue({
        code: "custom",
        message: "must set either command or url, not both",
      });
    } else if (!hasCommand && !hasUrl && server.disabled !== true) {
      ctx.addIssue({
        code: "custom",
        message:
          server.type === "stdio"
            ? "stdio servers require command"
            : server.type === "http" || server.type === "sse"
              ? `${server.type} servers require url`
              : "must set command (stdio) or url (http/sse)",
      });
    } else if (server.type === "stdio" && hasUrl) {
      ctx.addIssue({
        code: "custom",
        message: "stdio servers require command, not url",
      });
    } else if (
      (server.type === "http" || server.type === "sse") &&
      hasCommand
    ) {
      ctx.addIssue({
        code: "custom",
        message: `${server.type} servers require url, not command`,
      });
    }
    if (hasUrl && server.args !== undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["args"],
        message: "is only valid for stdio servers",
      });
    }
    if (hasUrl && server.env !== undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["env"],
        message: "is only valid for stdio servers",
      });
    }
    if (hasCommand && server.headers !== undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["headers"],
        message: "is only valid for http/sse servers",
      });
    }
  });

const configSchema = z
  .object({
    mcpServers: z.record(
      z
        .string()
        .regex(SERVER_NAME, "must contain only letters, numbers, '_' or '-'"),
      serverSchema,
    ),
  })
  .strict();

interface InterpolateContext {
  environment: Record<string, string | undefined>;
  workspaceFolder: string;
  userHome: string;
}

export interface WorkspaceMcpConfig {
  servers: McpServer[];
  // Hash of the resolved server list, including secret values, so an env
  // change refreshes the ACP session. Persist only this hash, never the
  // resolved servers, and never log it.
  fingerprint: string;
  // True when `servers` includes the auto-registered sandbox MCP gateway.
  // The runtime may drop that one server for a harness without HTTP MCP
  // support instead of failing the session, unlike user-configured servers.
  sandboxGateway: boolean;
}

export const SANDBOX_GATEWAY_SERVER_NAME = "sbx";

// Docker Sandboxes reserves an MCP gateway per sandbox and injects
// MCP_GATEWAY_URL + MCP_SENTINEL_TOKEN_NAME into the environment. The
// sentinel name is not a credential: the host proxy substitutes the real
// token at request time keyed by that name, which is why it is safe to put
// in a bearer header here.
export function sandboxMcpGatewayServer(
  environment: Record<string, string | undefined> = process.env,
): McpServer | null {
  if (environment.PHI_IN_SANDBOX !== "1") return null;
  const url = environment.MCP_GATEWAY_URL?.trim();
  const sentinel = environment.MCP_SENTINEL_TOKEN_NAME?.trim();
  if (!url || !sentinel) return null;
  if (!URL.canParse(url) || !/^https?:/i.test(url)) return null;
  return {
    type: "http",
    name: SANDBOX_GATEWAY_SERVER_NAME,
    url,
    headers: [{ name: "Authorization", value: `Bearer ${sentinel}` }],
  };
}

export async function loadWorkspaceMcpConfig(
  workspaceRoot: string,
  environment: Record<string, string | undefined> = process.env,
): Promise<WorkspaceMcpConfig> {
  const path = join(workspaceRoot, ".agents", "mcp.json");
  let source: string;
  try {
    source = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return withSandboxGateway([], environment, "absent");
    }
    throw new Error(
      `could not read .agents/mcp.json: ${(error as Error).message}`,
    );
  }

  let input: unknown;
  try {
    input = JSON.parse(source);
  } catch {
    // JSON parser errors can include excerpts from the source. Do not risk
    // echoing a malformed literal credential into a user-visible error.
    throw new Error("invalid .agents/mcp.json: could not parse JSON");
  }

  const parsed = configSchema.safeParse(input);
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `${formatPath(issue.path)}: ${issue.message}`)
      .join("; ");
    throw new Error(`invalid .agents/mcp.json: ${details}`);
  }
  const duplicate = duplicateMcpServerName(source);
  if (duplicate) {
    throw new Error(
      `invalid .agents/mcp.json: mcpServers.${duplicate}: duplicate server name`,
    );
  }
  for (const name of Object.keys(parsed.data.mcpServers)) {
    if (name.toLowerCase() === "phi") {
      throw new Error(
        `invalid .agents/mcp.json: mcpServers.${name}: "phi" is reserved by Phi`,
      );
    }
  }

  const interpolateCtx: InterpolateContext = {
    environment,
    workspaceFolder: workspaceRoot,
    userHome: homedir(),
  };
  const servers: McpServer[] = [];
  const sandboxGatewayOverridden = Object.hasOwn(
    parsed.data.mcpServers,
    SANDBOX_GATEWAY_SERVER_NAME,
  );
  for (const [name, server] of Object.entries(parsed.data.mcpServers)) {
    if (server.disabled === true) continue;
    servers.push(toAcpServer(name, server, interpolateCtx));
  }

  return withSandboxGateway(
    servers,
    environment,
    undefined,
    sandboxGatewayOverridden,
  );
}

// A user-configured server named "sbx" wins over the auto-registered
// gateway so the workspace can point that name elsewhere or disable it.
function withSandboxGateway(
  servers: McpServer[],
  environment: Record<string, string | undefined>,
  emptyFingerprint?: string,
  explicitlyOverridden = false,
): WorkspaceMcpConfig {
  const gateway = sandboxMcpGatewayServer(environment);
  const overridden =
    explicitlyOverridden ||
    servers.some((server) => server.name === SANDBOX_GATEWAY_SERVER_NAME);
  const resolved = gateway && !overridden ? [...servers, gateway] : servers;
  const sandboxGateway = resolved !== servers;
  if (resolved.length === 0 && emptyFingerprint !== undefined) {
    return { servers: [], fingerprint: emptyFingerprint, sandboxGateway };
  }
  return {
    servers: resolved,
    fingerprint: new Bun.CryptoHasher("sha256")
      .update(JSON.stringify(resolved))
      .digest("hex"),
    sandboxGateway,
  };
}

function toAcpServer(
  name: string,
  server: z.infer<typeof serverSchema>,
  ctx: InterpolateContext,
): McpServer {
  const prefix = `mcpServers.${name}`;
  if (server.command !== undefined) {
    const command = resolveCommand(
      interpolate(server.command, ctx, `${prefix}.command`),
      ctx.workspaceFolder,
      `${prefix}.command`,
    );
    return {
      name,
      command,
      args: (server.args ?? []).map((arg, index) =>
        interpolate(arg, ctx, `${prefix}.args.${index}`),
      ),
      env: Object.entries(server.env ?? {}).map(([envName, value]) => ({
        name: envName,
        value: interpolate(value, ctx, `${prefix}.env.${envName}`),
      })),
    };
  }

  const type = server.type === "sse" ? "sse" : "http";
  const url = interpolate(server.url!, ctx, `${prefix}.url`);
  if (!URL.canParse(url) || !/^https?:/i.test(url)) {
    throw new Error(
      `invalid .agents/mcp.json: ${prefix}.url: must use http:// or https://`,
    );
  }
  const headersInterpolate = Object.values(server.headers ?? {}).some((value) =>
    /\$\{[^}]+\}/.test(value),
  );
  if (headersInterpolate && !isHttpsOrLoopback(url)) {
    throw new Error(
      `invalid .agents/mcp.json: ${prefix}.url: interpolated headers require https:// (or http:// on localhost)`,
    );
  }
  return {
    type,
    name,
    url,
    headers: Object.entries(server.headers ?? {}).map(
      ([headerName, value]) => ({
        name: headerName,
        value: interpolate(value, ctx, `${prefix}.headers.${headerName}`),
      }),
    ),
  };
}

function resolveCommand(
  command: string,
  workspaceRoot: string,
  path: string,
): string {
  if (isAbsolute(command)) return command;
  if (command.includes("/") || command.includes("\\")) {
    return resolvePath(workspaceRoot, command);
  }
  const found = Bun.which(command);
  if (!found) {
    throw new Error(
      `invalid .agents/mcp.json: ${path}: command was not found on PATH`,
    );
  }
  return found;
}

function interpolate(
  value: string,
  ctx: InterpolateContext,
  path: string,
): string {
  return value.replace(INTERPOLATION, (match, expr: string) => {
    if (expr === "userHome") return ctx.userHome;
    if (expr === "workspaceFolder") return ctx.workspaceFolder;
    if (expr === "workspaceFolderBasename") {
      return basename(ctx.workspaceFolder);
    }
    if (expr === "pathSeparator" || expr === "/") return sep;
    const envName = expr.startsWith("env:") ? expr.slice(4) : expr;
    if (!ENV_NAME.test(envName)) {
      throw new Error(
        `invalid .agents/mcp.json: ${path}: unsupported interpolation "${match}"`,
      );
    }
    const resolved = ctx.environment[envName];
    if (resolved === undefined) {
      throw new Error(
        `invalid .agents/mcp.json: ${path}: environment variable "${envName}" is not set`,
      );
    }
    return resolved;
  });
}

function formatPath(path: PropertyKey[]): string {
  return path.length === 0 ? "$" : path.map(String).join(".");
}

function isHttpsOrLoopback(url: string): boolean {
  const parsed = new URL(url);
  if (parsed.protocol === "https:") return true;
  if (parsed.protocol !== "http:") return false;
  return (
    parsed.hostname === "localhost" ||
    parsed.hostname === "127.0.0.1" ||
    parsed.hostname === "[::1]" ||
    parsed.hostname === "::1"
  );
}

// JSON.parse keeps the last duplicate key. Scan the source so two entries
// with the same name fail the turn instead of silently merging.
function duplicateMcpServerName(source: string): string | undefined {
  const match = /"mcpServers"\s*:/.exec(source);
  if (!match || match.index === undefined) return undefined;
  let i = match.index + match[0].length;
  while (i < source.length && /\s/.test(source[i]!)) i++;
  if (source[i] !== "{") return undefined;
  const seen = new Set<string>();
  let depth = 1;
  let expectKey = true;
  i++;
  while (i < source.length && depth > 0) {
    const char = source[i]!;
    if (char === '"') {
      const { value, end } = readJsonString(source, i);
      i = end;
      if (depth === 1 && expectKey) {
        if (seen.has(value)) return value;
        seen.add(value);
        expectKey = false;
      }
      continue;
    }
    if (char === "{" || char === "[") {
      depth++;
      expectKey = false;
      i++;
      continue;
    }
    if (char === "}" || char === "]") {
      depth--;
      i++;
      continue;
    }
    if (char === "," && depth === 1) {
      expectKey = true;
    }
    i++;
  }
  return undefined;
}

function readJsonString(
  source: string,
  start: number,
): { value: string; end: number } {
  let i = start + 1;
  let escape = false;
  while (i < source.length) {
    const char = source[i]!;
    if (escape) {
      escape = false;
      i++;
      continue;
    }
    if (char === "\\") {
      escape = true;
      i++;
      continue;
    }
    if (char === '"') {
      return { value: JSON.parse(source.slice(start, i + 1)), end: i + 1 };
    }
    i++;
  }
  return { value: "", end: source.length };
}
