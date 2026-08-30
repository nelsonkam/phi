import type { CliOutput } from "@/cli";
import { VERSION } from "@/version";

interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface SandboxDependencies {
  env?: NodeJS.ProcessEnv;
  which?: typeof Bun.which;
  runCommand?: (args: string[], interactive?: boolean) => Promise<CommandResult>;
  startLease?: (args: string[]) => void;
  sleep?: (milliseconds: number) => Promise<void>;
  interactive?: boolean;
  confirm?: (question: string) => Promise<boolean>;
  openUrl?: (url: string) => Promise<void>;
}

const MINIMUM_SBX = "0.42.0-rc1";
const SANDBOX_PORT = 3141;

function registry(env: NodeJS.ProcessEnv): string {
  return (env.PHI_SANDBOX_REGISTRY?.trim() || "ghcr.io/nelsonkam").replace(
    /\/$/,
    "",
  );
}

export function officialKitRefs(
  env: NodeJS.ProcessEnv = process.env,
): { root: string; mixins: string[] } {
  const prefix = registry(env);
  return {
    root: `${prefix}/phi-kit:${VERSION}`,
    mixins: ["claude", "codex", "cursor"].map(
      (name) => `${prefix}/phi-${name}-kit:${VERSION}`,
    ),
  };
}

async function defaultRunCommand(
  args: string[],
  interactive = false,
): Promise<CommandResult> {
  const child = Bun.spawn(args, {
    stdin: interactive ? "inherit" : "ignore",
    stdout: interactive ? "inherit" : "pipe",
    stderr: interactive ? "inherit" : "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    interactive ? Promise.resolve("") : new Response(child.stdout).text(),
    interactive ? Promise.resolve("") : new Response(child.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}

function defaultStartLease(args: string[]): void {
  const child = Bun.spawn(args, {
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
    detached: true,
  });
  child.unref();
}

function commandError(args: readonly string[], result: CommandResult): Error {
  const detail = result.stderr.trim() || result.stdout.trim() || `exit ${result.exitCode}`;
  return new Error(`\`sbx ${args.join(" ")}\` failed: ${detail}`);
}

function parseVersion(output: string): string | null {
  return output.match(/\bv?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/)?.[1] ?? null;
}

export function supportsPhiSandbox(version: string): boolean {
  const match = version.match(/^(\d+)\.(\d+)\.(\d+)(?:-(.+))?$/);
  if (!match) return false;
  const tuple = match.slice(1, 4).map(Number);
  const minimum = [0, 42, 0];
  for (let index = 0; index < tuple.length; index += 1) {
    if (tuple[index]! > minimum[index]!) return true;
    if (tuple[index]! < minimum[index]!) return false;
  }
  if (!match[4]) return true;
  const rc = match[4].match(/^rc(\d+)$/);
  return Boolean(rc && Number(rc[1]) >= 1);
}

function parseJson(output: string, command: string): unknown {
  try {
    return JSON.parse(output);
  } catch {
    throw new Error(`${command} did not return machine-readable JSON`);
  }
}

function objects(value: unknown): Record<string, unknown>[] {
  if (Array.isArray(value)) return value.flatMap(objects);
  if (!value || typeof value !== "object") return [];
  const record = value as Record<string, unknown>;
  return [record, ...Object.values(record).flatMap(objects)];
}

function sandboxEntries(value: unknown): Record<string, unknown>[] {
  return objects(value).filter((entry) => typeof entry.name === "string");
}

function sandboxName(entry: Record<string, unknown>): string {
  return String(entry.name);
}

function isPhiSandbox(entry: Record<string, unknown>): boolean {
  const name = sandboxName(entry);
  const agent = entry.agent;
  const agentName = typeof agent === "string"
    ? agent
    : agent && typeof agent === "object"
      ? (agent as Record<string, unknown>).name
      : undefined;
  const kitReferences = [entry.kit, entry.kits, entry.kitRef, entry.kitRefs]
    .flatMap((value) => Array.isArray(value) ? value : [value])
    .filter((value): value is string => typeof value === "string");
  return agentName === "phi"
    || kitReferences.some((reference) => /(?:^|\/)phi-kit(?::|@|$)/.test(reference))
    || name === "phi"
    || name.startsWith("phi-");
}

function numericPort(value: unknown): number | null {
  if (typeof value === "number" && Number.isInteger(value)) return value;
  if (typeof value !== "string") return null;
  const match = value.match(/^(\d+)(?:\/(?:tcp|udp))?$/);
  return match ? Number(match[1]) : null;
}

function hostPort(value: unknown): number | null {
  for (const entry of objects(value)) {
    const container = entry.container
      ?? entry.containerPort
      ?? entry.container_port
      ?? entry.sandboxPort
      ?? entry.sandbox_port
      ?? entry.targetPort;
    const published = entry.hostPort
      ?? entry.host_port
      ?? entry.publishedPort
      ?? entry.published_port
      ?? entry.published;
    if (numericPort(container) !== SANDBOX_PORT) continue;
    const directPort = numericPort(published);
    if (directPort !== null) return directPort;
    if (typeof published === "string") {
      const port = published.match(/(?:^|:)(\d+)(?:->|$)/)?.[1];
      if (port) return Number(port);
    }
    if (entry.host && typeof entry.host === "object") {
      const port = Number((entry.host as Record<string, unknown>).port);
      if (Number.isInteger(port)) return port;
    }
  }
  return null;
}

function flattenLeaves(
  value: unknown,
  prefix = "",
  result = new Map<string, string>(),
): Map<string, string> {
  if (Array.isArray(value)) {
    value.forEach((item, index) => flattenLeaves(item, `${prefix}[${index}]`, result));
  } else if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (["name", "displayName", "description", "version", "sourceURL"].includes(key)) {
        continue;
      }
      flattenLeaves(item, prefix ? `${prefix}.${key}` : key, result);
    }
  } else if (prefix) {
    result.set(prefix, JSON.stringify(value));
  }
  return result;
}

function overriddenPaths(base: unknown[], custom: unknown): string[] {
  const prior = new Map<string, string>();
  for (const value of base) {
    for (const [path, leaf] of flattenLeaves(value)) prior.set(path, leaf);
  }
  return [...flattenLeaves(custom)]
    .filter(([path, leaf]) => prior.has(path) && prior.get(path) !== leaf)
    .map(([path]) => path)
    .sort();
}

async function defaultConfirm(question: string): Promise<boolean> {
  const answer = prompt(`${question} [y/N]`)?.trim().toLowerCase();
  return answer === "y" || answer === "yes";
}

async function defaultOpenUrl(url: string): Promise<void> {
  const command = process.platform === "darwin" ? "open" : "xdg-open";
  const child = Bun.spawn([command, url], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
  if ((await child.exited) !== 0) throw new Error(`could not open ${url}`);
}

function parseCreateArgs(args: readonly string[]): {
  name: string;
  customKits: string[];
  confirmed: boolean;
} {
  let name = "phi";
  let confirmed = false;
  const customKits: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === "--name") {
      name = args[++index] ?? "";
    } else if (arg === "--kit") {
      customKits.push(args[++index] ?? "");
    } else if (arg === "--confirm") {
      confirmed = true;
    } else {
      throw new Error(`unknown create argument ${JSON.stringify(arg)}`);
    }
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9.+-]*$/.test(name)) {
    throw new Error("sandbox name must contain only letters, numbers, dots, pluses, and hyphens");
  }
  if (customKits.some((kit) => !kit.trim())) throw new Error("--kit requires a reference");
  return { name, customKits, confirmed };
}

export async function runSandbox(
  output: CliOutput,
  args: readonly string[],
  dependencies: SandboxDependencies = {},
): Promise<number> {
  const env = dependencies.env ?? process.env;
  const [subcommand = "help", ...rest] = args;
  if (subcommand === "help" || subcommand === "--help" || subcommand === "-h") {
    output.stdout(`Usage: phi sandbox <command>\n\nCommands:\n  create [--name NAME] [--kit MIXIN]...\n  status [NAME]\n  open [NAME]\n  stop [NAME]\n  start [NAME]\n  remove NAME --confirm\n`);
    return 0;
  }
  if (env.PHI_IN_SANDBOX === "1") {
    throw new Error("sandbox lifecycle commands cannot run inside a Phi sandbox");
  }
  const which = dependencies.which ?? Bun.which;
  const sbx = which("sbx");
  if (!sbx) throw new Error("sbx is not installed; install Docker Sandboxes v0.42.0-rc1 or newer");
  const runner = dependencies.runCommand ?? defaultRunCommand;
  const startLease = dependencies.startLease ?? defaultStartLease;
  const sleep = dependencies.sleep ?? Bun.sleep;
  const run = async (command: string[], interactive = false) => {
    const result = await runner([sbx, ...command], interactive);
    if (result.exitCode !== 0) throw commandError(command, result);
    return result;
  };

  const versionResult = await run(["version"]);
  const version = parseVersion(`${versionResult.stdout}\n${versionResult.stderr}`);
  if (!version || !supportsPhiSandbox(version)) {
    throw new Error(
      `Phi sandboxes require sbx v${MINIMUM_SBX} or newer; found ${version ? `v${version}` : "an unknown version"}`,
    );
  }

  const list = async () => parseJson((await run(["ls", "--json"])).stdout, "sbx ls --json");
  const resolveName = async (requested?: string): Promise<string> => {
    const candidates = sandboxEntries(await list()).filter(isPhiSandbox);
    if (requested) {
      const exact = candidates.find((entry) => sandboxName(entry) === requested);
      if (!exact) throw new Error(`Phi sandbox ${JSON.stringify(requested)} was not found`);
      return sandboxName(exact);
    }
    const names = [...new Set(candidates.map(sandboxName))];
    if (names.length === 1) return names[0]!;
    throw new Error(
      names.length === 0
        ? "no Phi sandbox was found"
        : `multiple Phi sandboxes exist; pass one of: ${names.join(", ")}`,
    );
  };
  const publishedUrl = async (name: string): Promise<string | null> => {
    const ports = parseJson(
      (await run(["ports", name, "--json"])).stdout,
      "sbx ports --json",
    );
    const port = hostPort(ports);
    return port ? `http://127.0.0.1:${port}` : null;
  };
  const leaseUrl = async (name: string, forceStart = false): Promise<string> => {
    if (!forceStart) {
      const existing = await publishedUrl(name);
      if (existing) return existing;
    }
    startLease([sbx, "exec", name, "sleep", "infinity"]);
    for (let attempt = 0; attempt < 60; attempt += 1) {
      const url = await publishedUrl(name);
      if (url) return url;
      await sleep(500);
    }
    throw new Error(`sandbox ${JSON.stringify(name)} did not publish the Phi web port after starting`);
  };

  if (subcommand === "create") {
    const { name, customKits, confirmed } = parseCreateArgs(rest);
    const official = officialKitRefs(env);
    const refs = [official.root, ...official.mixins, ...customKits];
    const inspected: unknown[] = [];
    output.stdout(`Sandbox ${name} will use:\n${refs.map((ref) => `  ${ref}`).join("\n")}\n`);
    if (customKits.length > 0) {
      let inspectionAvailable = true;
      for (const ref of refs) {
        const command = ["kit", "inspect", ref, "--json"];
        try {
          const result = await runner([sbx, ...command]);
          if (result.exitCode !== 0) {
            inspectionAvailable = false;
            break;
          }
          inspected.push(parseJson(result.stdout, `sbx kit inspect ${ref} --json`));
        } catch {
          inspectionAvailable = false;
          break;
        }
      }
      if (!inspectionAvailable) {
        output.stderr(
          "Warning: sbx kit inspect --json is unavailable; kit override analysis was skipped. Custom mixins still require explicit confirmation.\n",
        );
      } else {
        for (let index = 0; index < customKits.length; index += 1) {
          const overrides = overriddenPaths(inspected.slice(0, official.mixins.length + 1), inspected[official.mixins.length + 1 + index]);
          if (overrides.length > 0) {
            output.stdout(`Custom mixin ${customKits[index]} overrides: ${overrides.join(", ")}\n`);
          }
        }
      }
    }
    if (customKits.length > 0 && !confirmed) {
      const interactive = dependencies.interactive ?? Boolean(process.stdin.isTTY && process.stdout.isTTY);
      if (!interactive) {
        throw new Error("custom mixins require --confirm in a non-interactive run");
      }
      const accepted = await (dependencies.confirm ?? defaultConfirm)(
        "Custom mixins compose last and can override official kit fields. Continue?",
      );
      if (!accepted) return 1;
    }

    const interactive = dependencies.interactive ?? Boolean(process.stdin.isTTY && process.stdout.isTTY);
    output.stdout(
      "Authentication is managed by sbx. Phi never receives provider API keys or OAuth tokens.\n",
    );
    const create = ["create", "--name", name, official.root];
    for (const kit of [...official.mixins, ...customKits]) create.push("--kit", kit);
    await run(create, interactive);
    const url = await leaseUrl(name, true);
    output.stdout(`Phi sandbox ${name}: ${url}\n`);
    if (interactive) await (dependencies.openUrl ?? defaultOpenUrl)(url);
    return 0;
  }

  if (subcommand === "status") {
    if (rest.length > 1) throw new Error("Usage: phi sandbox status [NAME]");
    const data = await list();
    if (!rest[0]) {
      const entries = sandboxEntries(data).filter(isPhiSandbox);
      output.stdout(`${JSON.stringify(entries, null, 2)}\n`);
      return 0;
    }
    const entry = sandboxEntries(data).find((candidate) => sandboxName(candidate) === rest[0]);
    if (!entry) throw new Error(`sandbox ${JSON.stringify(rest[0])} was not found`);
    output.stdout(`${JSON.stringify(entry, null, 2)}\n`);
    return 0;
  }

  if (subcommand === "open") {
    if (rest.length > 1) throw new Error("Usage: phi sandbox open [NAME]");
    const name = await resolveName(rest[0]);
    const url = await leaseUrl(name);
    output.stdout(`${url}\n`);
    await (dependencies.openUrl ?? defaultOpenUrl)(url);
    return 0;
  }

  if (subcommand === "stop" || subcommand === "start") {
    if (rest.length > 1) throw new Error(`Usage: phi sandbox ${subcommand} [NAME]`);
    const name = await resolveName(rest[0]);
    if (subcommand === "stop") {
      await run(["stop", name]);
    } else {
      await leaseUrl(name);
    }
    output.stdout(`Phi sandbox ${name} ${subcommand === "stop" ? "stopped" : "started"}.\n`);
    return 0;
  }

  if (subcommand === "remove") {
    if (rest.length !== 2 || rest[1] !== "--confirm") {
      throw new Error("Usage: phi sandbox remove NAME --confirm");
    }
    const name = rest[0]!;
    const exact = await resolveName(name);
    output.stdout(`Removing ${exact} deletes its Phi database, repositories, worktrees, VM filesystem, and volumes.\n`);
    await run(["rm", "--force", exact]);
    output.stdout(`Phi sandbox ${exact} removed.\n`);
    return 0;
  }

  throw new Error(`unknown sandbox command ${JSON.stringify(subcommand)}`);
}
