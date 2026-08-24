#!/usr/bin/env bun
import { PhiApp } from "./app.ts";
import { loadConfig } from "./config.ts";
import { doctor } from "./doctor.ts";
import { runDirectTui } from "./ui/direct-tui.ts";

function value(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

function configInput(args: string[]): Parameters<typeof loadConfig>[0] {
  const result: Parameters<typeof loadConfig>[0] = {};
  const workspace = value(args, "--workspace");
  const runtimeDir = value(args, "--runtime");
  const adapter = value(args, "--adapter");
  const credentialMode = value(args, "--credential-mode");
  const concurrencyText = value(args, "--concurrency");
  const coordinatorModel = value(args, "--coordinator-model");
  if (workspace) result.workspace = workspace;
  if (runtimeDir) result.runtimeDir = runtimeDir;
  if (adapter) result.adapter = adapter;
  if (credentialMode === "native" || credentialMode === "isolated")
    result.credentialMode = credentialMode;
  else if (credentialMode)
    throw new Error("--credential-mode must be native or isolated");
  if (concurrencyText) result.concurrency = Number(concurrencyText);
  if (coordinatorModel) result.coordinatorModel = coordinatorModel;
  return result;
}

function positionals(args: string[]): string[] {
  const flagsWithValues = new Set([
    "--workspace",
    "--runtime",
    "--adapter",
    "--credential-mode",
    "--concurrency",
    "--coordinator-model",
  ]);
  const result: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const current = args[index]!;
    if (flagsWithValues.has(current)) {
      index += 1;
      continue;
    }
    if (current === "--direct") continue;
    result.push(current);
  }
  return result;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const command = args[0] && !args[0].startsWith("-") ? args.shift()! : "tui";
  const config = loadConfig(configInput(args));
  if (command === "doctor") {
    const checks = await doctor(config);
    for (const check of checks)
      process.stdout.write(
        `${check.ok ? "PASS" : "WARN"} ${check.name}: ${check.detail}\n`,
      );
    if (checks.some((check) => !check.ok && !check.name.includes("credential")))
      process.exitCode = 1;
    return;
  }
  const direct = args.includes("--direct");
  const app = await PhiApp.create(config, { directCoordinator: direct });
  app.start();
  const close = async () => {
    await app.close();
  };
  process.once("SIGTERM", () => void close());
  try {
    if (command === "once") {
      const message = positionals(args).join(" ");
      if (!message) throw new Error("phi once requires a message");
      await app.submitUserMessage(message);
      await app.waitUntilIdle(30_000);
    } else if (command === "tui") {
      if (direct) await runDirectTui(app);
      else await app.runDeveloperTui();
    } else throw new Error(`unknown command: ${command}`);
  } finally {
    await close();
  }
}

await main().catch((error) => {
  process.stderr.write(
    `phi: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
});
