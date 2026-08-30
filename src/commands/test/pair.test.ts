import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { normalizeServerOrigin, runPair } from "@/commands/pair";
import type { CliOutput } from "@/cli";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function captureOutput() {
  let stdout = "";
  const output: CliOutput = {
    stdout: (message) => { stdout += message; },
    stderr: () => {},
  };
  return { output, stdout: () => stdout };
}

describe("pair command", () => {
  test("prints a durable token and a secret-free macOS deep link", () => {
    const root = mkdtempSync(join(tmpdir(), "phi-pair-"));
    roots.push(root);
    const capture = captureOutput();

    expect(
      runPair(
        capture.output,
        ["--server", "https://Phi.Example.com/", "--name", "Home Phi"],
        { root },
      ),
    ).toBe(0);
    const token = readFileSync(join(root, "device-token"), "utf8").trim();
    expect(capture.stdout()).toContain(token);

    const link = capture.stdout().split("\n").find((line) => line.startsWith("phi://"));
    expect(link).toBeDefined();
    const url = new URL(link!);
    expect(url.hostname).toBe("add-server");
    expect(url.searchParams.get("origin")).toBe("https://phi.example.com/");
    expect(url.searchParams.get("name")).toBe("Home Phi");
    expect(link).not.toContain(token);
    expect(url.searchParams.has("token")).toBe(false);

    const second = captureOutput();
    runPair(second.output, ["--server", "https://phi.example.com"], { root });
    expect(second.stdout()).toContain(token);
  });

  test("accepts loopback forwarding and rejects unsafe remote origins", () => {
    expect(normalizeServerOrigin("http://127.0.0.1:43141").href).toBe(
      "http://127.0.0.1:43141/",
    );
    expect(() => normalizeServerOrigin("http://phi.example.com")).toThrow(
      "non-loopback servers require https",
    );
    expect(() => normalizeServerOrigin("https://phi.example.com/path")).toThrow(
      "without a path",
    );
    expect(() => normalizeServerOrigin("https://secret@phi.example.com")).toThrow(
      "must not contain credentials",
    );
  });
});
