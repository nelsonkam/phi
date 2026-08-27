#!/usr/bin/env bun

import { runUpdate } from "@/commands/update";
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
  update   Update the compiled binary to the latest GitHub release
  help     Show this help message
  version  Show the phi version

Options:
  -h, --help       Show this help message
  -V, --version    Show the phi version
`;

export interface CliDependencies {
  serve(): Promise<number>;
  update(output: CliOutput, args: readonly string[]): Promise<number>;
}

const defaultDependencies: CliDependencies = {
  serve: async () => {
    const { startServer } = await import("@/server/serve");
    await startServer();
    return 0;
  },
  update: (output, args) => runUpdate(output, {}, [...args]),
};

export async function runCli(
  args: readonly string[],
  output: CliOutput = defaultOutput,
  dependencies: CliDependencies = defaultDependencies,
): Promise<number> {
  const [command] = args;

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

  if (command === "update") {
    try {
      return await dependencies.update(output, args.slice(1));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      output.stderr(`phi update failed: ${message}\n`);
      return 1;
    }
  }

  output.stderr(`Unknown command: ${command}\nRun 'phi --help' for usage.\n`);
  return 1;
}

if (import.meta.main) {
  process.exitCode = await runCli(Bun.argv.slice(2));
}
