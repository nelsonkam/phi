import { createInterface } from "node:readline/promises";
import type { PhiApp } from "../app.ts";

export async function runDirectTui(app: PhiApp): Promise<void> {
  const readline = createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: true,
  });
  process.stdout.write(
    "Phi direct developer shell. Use /dispatch, /follow, /cancel, or /quit.\n",
  );
  try {
    while (true) {
      const line = await readline.question("phi> ");
      if (line.trim() === "/quit") break;
      await app.submitUserMessage(line);
    }
  } finally {
    readline.close();
  }
}
