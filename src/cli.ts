#!/usr/bin/env bun
const command = process.argv[2] ?? "serve";

switch (command) {
  case "serve": {
    const { startServer } = await import("./server/serve");
    startServer();
    break;
  }
  default: {
    console.error(`Unknown command: ${command}`);
    console.error("Usage: phi [serve]");
    process.exit(1);
  }
}
