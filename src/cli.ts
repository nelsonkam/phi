#!/usr/bin/env bun

import { runUpdate } from "@/commands/update";
import { runSandbox } from "@/commands/sandbox";
import { runPair } from "@/commands/pair";
import { runService } from "@/commands/service";
import { VERSION } from "@/version";

export interface CliOutput {
  stdout(message: string): void;
  stderr(message: string): void;
}

const defaultOutput: CliOutput = {
  stdout: (message) => process.stdout.write(message),
  stderr: (message) => process.stderr.write(message),
};

const help = `Usage: phi [command]

Commands:
  serve    Start the phi server and UI (default)
  service  Install and manage Phi as a background service
  update   Update the compiled binary to the latest GitHub release
  sandbox  Manage Phi's Docker Sandbox
  pair     Show a device token and macOS Add Server link
  help     Show this help message
  version  Show the phi version

Options:
  -h, --help       Show this help message
  -V, --version    Show the phi version
`;

export interface CliDependencies {
  serve(): Promise<number>;
  service(output: CliOutput, args: readonly string[]): Promise<number>;
  update(output: CliOutput, args: readonly string[]): Promise<number>;
  sandbox(output: CliOutput, args: readonly string[]): Promise<number>;
  pair(output: CliOutput, args: readonly string[]): Promise<number> | number;
}

const defaultDependencies: CliDependencies = {
  serve: async () => {
    const { startServer } = await import("@/server/serve");
    await startServer();
    return 0;
  },
  service: (output, args) =>
    runService(output, args, { cliPath: import.meta.path }),
  update: (output, args) => runUpdate(output, {}, [...args]),
  sandbox: (output, args) => runSandbox(output, args),
  pair: (output, args) => runPair(output, args),
};

export async function runCli(
  args: readonly string[],
  output: CliOutput = defaultOutput,
  dependencies: CliDependencies = defaultDependencies,
): Promise<number> {
  const [command] = args;

  // A compiled Phi executable cannot be reused as the Bun interpreter for
  // adapter entry files. These private modes keep both ACP adapters bundled
  // and let the harness catalog launch them through the same executable.
  if (command === "__acp-claude") {
    process.env.CLAUDE_CODE_EXECUTABLE ??= Bun.which("claude") ?? "claude";
    await import("@agentclientprotocol/claude-agent-acp/dist/index.js");
    return 0;
  }
  if (command === "__acp-codex") {
    process.env.CODEX_PATH ??= Bun.which("codex") ?? "codex";
    await import("@agentclientprotocol/codex-acp/dist/index.js");
    return 0;
  }

  if (command === "help" || command === "-h" || command === "--help") {
    output.stdout(help);
    return 0;
  }

  if (command === "version" || command === "-V" || command === "--version") {
    output.stdout(`phi ${VERSION}\n`);
    return 0;
  }

  if (command === undefined || command === "serve") {
    try {
      return await dependencies.serve();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      output.stderr(`phi failed to start: ${message}\n`);
      return 1;
    }
  }

  if (command === "service") {
    try {
      return await dependencies.service(output, args.slice(1));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      output.stderr(`phi service failed: ${message}\n`);
      return 1;
    }
  }

  if (command === "update") {
    try {
      return await dependencies.update(output, args.slice(1));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      output.stderr(`phi update failed: ${message}\n`);
      return 1;
    }
  }

  if (command === "sandbox") {
    try {
      return await dependencies.sandbox(output, args.slice(1));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      output.stderr(`phi sandbox failed: ${message}\n`);
      return 1;
    }
  }

  if (command === "pair") {
    try {
      return await dependencies.pair(output, args.slice(1));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      output.stderr(`phi pair failed: ${message}\n`);
      return 1;
    }
  }

  output.stderr(`Unknown command: ${command}\nRun 'phi --help' for usage.\n`);
  return 1;
}

if (import.meta.main) {
  process.exitCode = await runCli(Bun.argv.slice(2));
}
