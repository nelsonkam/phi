import { describe, expect, test } from "bun:test";

import { type CliDependencies, type CliOutput, runCli } from "@/cli";
import { VERSION } from "@/version";

function captureOutput() {
  let stdout = "";
  let stderr = "";

  const output: CliOutput = {
    stdout: (message) => {
      stdout += message;
    },
    stderr: (message) => {
      stderr += message;
    },
  };

  return {
    output,
    stdout: () => stdout,
    stderr: () => stderr,
  };
}

function unusedDependencies(
  overrides: Partial<CliDependencies> = {},
): CliDependencies {
  return {
    serve: async () => 0,
    update: async () => 0,
    sandbox: async () => 0,
    pair: async () => 0,
    ...overrides,
  };
}

describe("runCli", () => {
  test("serves when given no arguments and does not print usage", async () => {
    const capture = captureOutput();
    let served = false;
    const dependencies = unusedDependencies({
      serve: async () => {
        served = true;
        return 0;
      },
    });

    expect(await runCli([], capture.output, dependencies)).toBe(0);
    expect(served).toBe(true);
    expect(capture.stdout()).toBe("");
    expect(capture.stderr()).toBe("");
  });

  const helpCases: ReadonlyArray<[readonly string[]]> = [
    [["help"]],
    [["--help"]],
    [["-h"]],
  ];

  test.each(helpCases)(
    "prints help for %j and does not serve",
    async (args) => {
      const capture = captureOutput();
      let served = false;
      const dependencies = unusedDependencies({
        serve: async () => {
          served = true;
          return 0;
        },
      });

      expect(await runCli(args, capture.output, dependencies)).toBe(0);
      expect(served).toBe(false);
      expect(capture.stdout()).toContain("Usage: phi [command]");
      expect(capture.stderr()).toBe("");
    },
  );

  const versionCases: ReadonlyArray<[readonly string[]]> = [
    [["version"]],
    [["--version"]],
    [["-V"]],
  ];

  test.each(versionCases)(
    "prints the version for %j",
    async (args) => {
      const capture = captureOutput();

      expect(await runCli(args, capture.output, unusedDependencies())).toBe(0);
      expect(capture.stdout()).toBe(`phi ${VERSION}\n`);
      expect(capture.stderr()).toBe("");
    },
  );

  test("serves the runtime", async () => {
    const capture = captureOutput();
    let called = false;
    const dependencies = unusedDependencies({
      serve: async () => {
        called = true;
        return 0;
      },
    });

    expect(await runCli(["serve"], capture.output, dependencies)).toBe(0);
    expect(called).toBe(true);
    expect(capture.stderr()).toBe("");
  });

  test("reports startup failures", async () => {
    const capture = captureOutput();
    const dependencies = unusedDependencies({
      serve: async () => {
        throw new Error("database is locked");
      },
    });

    expect(await runCli(["serve"], capture.output, dependencies)).toBe(1);
    expect(capture.stderr()).toBe("phi failed to start: database is locked\n");
  });

  test("forwards remaining args to update", async () => {
    const capture = captureOutput();
    let received: readonly string[] | undefined;
    const dependencies = unusedDependencies({
      update: async (_output, args) => {
        received = args;
        return 0;
      },
    });

    expect(await runCli(["update", "--force"], capture.output, dependencies)).toBe(0);
    expect(received).toEqual(["--force"]);
  });

  test("reports updater failures", async () => {
    const capture = captureOutput();
    const dependencies = unusedDependencies({
      update: async () => {
        throw new Error("release unavailable");
      },
    });

    expect(await runCli(["update"], capture.output, dependencies)).toBe(1);
    expect(capture.stderr()).toBe("phi update failed: release unavailable\n");
  });

  test("forwards sandbox subcommands and reports failures", async () => {
    const capture = captureOutput();
    let received: readonly string[] | undefined;
    const dependencies = unusedDependencies({
      sandbox: async (_output, args) => {
        received = args;
        throw new Error("sbx is too old");
      },
    });

    expect(await runCli(["sandbox", "status", "phi"], capture.output, dependencies)).toBe(1);
    expect(received).toEqual(["status", "phi"]);
    expect(capture.stderr()).toBe("phi sandbox failed: sbx is too old\n");
  });

  test("forwards pairing arguments and reports failures", async () => {
    const capture = captureOutput();
    let received: readonly string[] | undefined;
    const dependencies = unusedDependencies({
      pair: async (_output, args) => {
        received = args;
        throw new Error("--server is required");
      },
    });

    expect(
      await runCli(
        ["pair", "--server", "https://phi.example.com"],
        capture.output,
        dependencies,
      ),
    ).toBe(1);
    expect(received).toEqual(["--server", "https://phi.example.com"]);
    expect(capture.stderr()).toBe("phi pair failed: --server is required\n");
  });

  test("rejects an unknown command", async () => {
    const capture = captureOutput();

    expect(await runCli(["build"], capture.output, unusedDependencies())).toBe(1);
    expect(capture.stdout()).toBe("");
    expect(capture.stderr()).toContain("Unknown command: build");
  });
});
