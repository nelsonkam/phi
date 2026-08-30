import { expect, test } from "bun:test";
import type { CliOutput } from "@/cli";
import { officialKitRefs, runSandbox, supportsPhiSandbox } from "@/commands/sandbox";
import { VERSION } from "@/version";

function capture() {
  let stdout = "";
  let stderr = "";
  const output: CliOutput = {
    stdout: (message) => { stdout += message; },
    stderr: (message) => { stderr += message; },
  };
  return { output, stdout: () => stdout, stderr: () => stderr };
}

test("requires the no-workspace sbx release line", () => {
  expect(supportsPhiSandbox("0.41.9")).toBe(false);
  expect(supportsPhiSandbox("0.42.0-beta1")).toBe(false);
  expect(supportsPhiSandbox("0.42.0-rc1")).toBe(true);
  expect(supportsPhiSandbox("0.42.0-rc2")).toBe(true);
  expect(supportsPhiSandbox("0.42.0")).toBe(true);
  expect(supportsPhiSandbox("1.0.0")).toBe(true);
});

test("official kits default to the GitHub container registry", () => {
  expect(officialKitRefs({})).toEqual({
    root: `ghcr.io/nelsonkam/phi-kit:${VERSION}`,
    mixins: [
      `ghcr.io/nelsonkam/phi-claude-kit:${VERSION}`,
      `ghcr.io/nelsonkam/phi-codex-kit:${VERSION}`,
      `ghcr.io/nelsonkam/phi-cursor-kit:${VERSION}`,
    ],
  });
});

test("create composes pinned official kits and a custom mixin as exact argv", async () => {
  const calls: string[][] = [];
  const leases: string[][] = [];
  const captureOutput = capture();
  const refs = officialKitRefs({ PHI_SANDBOX_REGISTRY: "registry.test/phi" });
  const exitCode = await runSandbox(
    captureOutput.output,
    [
      "create",
      "--name",
      "desk",
      "--port",
      "43141",
      "--kit",
      "./custom-kit",
      "--confirm",
    ],
    {
      env: { PHI_SANDBOX_REGISTRY: "registry.test/phi" },
      which: () => "/fake/sbx",
      interactive: false,
      startLease: (args) => { leases.push(args); },
      runCommand: async (args) => {
        calls.push(args);
        const command = args.slice(1);
        if (command[0] === "version") {
          return { exitCode: 0, stdout: "sbx version: v0.42.0-rc1\n", stderr: "" };
        }
        if (command[0] === "kit") {
          const custom = command[2] === "./custom-kit";
          return {
            exitCode: 0,
            stdout: JSON.stringify(custom
              ? { permissions: { network: { allow: ["custom.test"] } } }
              : { permissions: { network: { allow: ["official.test"] } } }),
            stderr: "",
          };
        }
        if (command[0] === "ports") {
          return {
            exitCode: 0,
            stdout: JSON.stringify([{ container: "3141/tcp", hostPort: 45123 }]),
            stderr: "",
          };
        }
        return { exitCode: 0, stdout: "{}", stderr: "" };
      },
    },
  );

  expect(exitCode).toBe(0);
  const create = calls.find((call) => call[1] === "create")!;
  expect(create).toEqual([
    "/fake/sbx",
    "create",
    "--name",
    "desk",
    "--publish",
    "127.0.0.1:43141:3141/tcp4",
    refs.root,
    "--kit",
    refs.mixins[0]!,
    "--kit",
    refs.mixins[1]!,
    "--kit",
    refs.mixins[2]!,
    "--kit",
    "./custom-kit",
  ]);
  expect(create).not.toContain(".");
  expect(leases).toEqual([["/fake/sbx", "exec", "desk", "sleep", "infinity"]]);
  expect(captureOutput.stdout()).toContain("http://127.0.0.1:45123");
  expect(captureOutput.stdout()).toContain("overrides");
});

test("create validates a requested stable host port before invoking sbx", async () => {
  for (const value of ["", "0", "65536", "3.14", "nope"]) {
    const calls: string[][] = [];
    await expect(runSandbox(capture().output, ["create", "--port", value], {
      env: {},
      which: () => "/fake/sbx",
      runCommand: async (args) => {
        calls.push(args);
        return { exitCode: 0, stdout: "v0.42.0\n", stderr: "" };
      },
    })).rejects.toThrow("--port must be an integer from 1 to 65535");
    expect(calls.some((call) => call[1] === "create")).toBe(false);
  }
});

test("create continues when JSON kit inspection is unavailable", async () => {
  const calls: string[][] = [];
  const captureOutput = capture();
  const exitCode = await runSandbox(
    captureOutput.output,
    ["create", "--kit", "./custom-kit", "--confirm"],
    {
      env: {},
      which: () => "/fake/sbx",
      interactive: false,
      startLease: () => {},
      runCommand: async (args) => {
        calls.push(args);
        const command = args.slice(1);
        if (command[0] === "version") {
          return { exitCode: 0, stdout: "v0.42.0\n", stderr: "" };
        }
        if (command[0] === "kit") {
          return { exitCode: 2, stdout: "", stderr: "unknown flag: --json" };
        }
        if (command[0] === "ports") {
          return {
            exitCode: 0,
            stdout: JSON.stringify([{ container: 3141, published: "127.0.0.1:45123->3141/tcp" }]),
            stderr: "",
          };
        }
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    },
  );

  expect(exitCode).toBe(0);
  expect(calls.some((call) => call[1] === "create")).toBe(true);
  expect(captureOutput.stderr()).toContain("override analysis was skipped");
  expect(captureOutput.stdout()).toContain("http://127.0.0.1:45123");
});

test("a non-interactive create does not require API keys before OAuth login", async () => {
  const captureOutput = capture();
  const calls: string[][] = [];
  const exitCode = await runSandbox(captureOutput.output, ["create"], {
    env: {},
    which: () => "/fake/sbx",
    interactive: false,
    startLease: () => {},
    runCommand: async (args) => {
      calls.push(args);
      const command = args.slice(1);
      if (command[0] === "version") {
        return { exitCode: 0, stdout: "v0.42.0\n", stderr: "" };
      }
      if (command[0] === "ports") {
        return {
          exitCode: 0,
          stdout: JSON.stringify([{ container: 3141, hostPort: 45123 }]),
          stderr: "",
        };
      }
      return { exitCode: 0, stdout: "{}", stderr: "" };
    },
  });
  expect(exitCode).toBe(0);
  expect(calls.some((call) => call[1] === "secret")).toBe(false);
  expect(calls.some((call) => call[1] === "create")).toBe(true);
  expect(captureOutput.stdout()).toContain("API keys or OAuth tokens");
});

test("open accepts the snake_case port payload from sbx v0.42.0-rc2", async () => {
  const captureOutput = capture();
  const opened: string[] = [];
  const exitCode = await runSandbox(captureOutput.output, ["open", "phi"], {
    env: {},
    which: () => "/fake/sbx",
    openUrl: async (url) => { opened.push(url); },
    runCommand: async (args) => {
      const command = args.slice(1);
      if (command[0] === "version") {
        return { exitCode: 0, stdout: "sbx version: v0.42.0-rc2\n", stderr: "" };
      }
      if (command[0] === "ls") {
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            sandboxes: [{ name: "phi", agent: "phi", status: "running" }],
          }),
          stderr: "",
        };
      }
      if (command[0] === "ports") {
        return {
          exitCode: 0,
          stdout: JSON.stringify([
            {
              host_ip: "127.0.0.1",
              host_port: 49152,
              sandbox_port: 3141,
              protocol: "tcp",
            },
            {
              host_ip: "::1",
              host_port: 49152,
              sandbox_port: 3141,
              protocol: "tcp",
            },
          ]),
          stderr: "",
        };
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    },
  });

  expect(exitCode).toBe(0);
  expect(captureOutput.stdout()).toBe("http://127.0.0.1:49152\n");
  expect(opened).toEqual(["http://127.0.0.1:49152"]);
});

test("open starts a service lease when a stopped sandbox has no ports", async () => {
  const captureOutput = capture();
  const leases: string[][] = [];
  let portChecks = 0;
  const exitCode = await runSandbox(captureOutput.output, ["open", "phi"], {
    env: {},
    which: () => "/fake/sbx",
    openUrl: async () => {},
    sleep: async () => {},
    startLease: (args) => { leases.push(args); },
    runCommand: async (args) => {
      const command = args.slice(1);
      if (command[0] === "version") {
        return { exitCode: 0, stdout: "v0.42.0-rc2\n", stderr: "" };
      }
      if (command[0] === "ls") {
        return {
          exitCode: 0,
          stdout: JSON.stringify({ sandboxes: [{ name: "phi", agent: "phi", status: "stopped" }] }),
          stderr: "",
        };
      }
      if (command[0] === "ports") {
        portChecks += 1;
        return {
          exitCode: 0,
          stdout: JSON.stringify(portChecks === 1
            ? []
            : [{ sandbox_port: 3141, host_port: 49152 }]),
          stderr: "",
        };
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    },
  });

  expect(exitCode).toBe(0);
  expect(leases).toEqual([["/fake/sbx", "exec", "phi", "sleep", "infinity"]]);
  expect(captureOutput.stdout()).toBe("http://127.0.0.1:49152\n");
});

test("start uses a persistent service lease instead of a detached agent session", async () => {
  const captureOutput = capture();
  const calls: string[][] = [];
  const leases: string[][] = [];
  let portChecks = 0;
  await runSandbox(captureOutput.output, ["start", "phi"], {
    env: {},
    which: () => "/fake/sbx",
    startLease: (args) => { leases.push(args); },
    runCommand: async (args) => {
      calls.push(args);
      const command = args.slice(1);
      if (command[0] === "version") {
        return { exitCode: 0, stdout: "v0.42.0-rc2\n", stderr: "" };
      }
      if (command[0] === "ls") {
        return {
          exitCode: 0,
          stdout: JSON.stringify({ sandboxes: [{ name: "phi", agent: "phi", status: "stopped" }] }),
          stderr: "",
        };
      }
      if (command[0] === "ports") {
        portChecks += 1;
        return {
          exitCode: 0,
          stdout: JSON.stringify(portChecks === 1
            ? []
            : [{ sandbox_port: 3141, host_port: 49152 }]),
          stderr: "",
        };
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    },
  });

  expect(leases).toEqual([["/fake/sbx", "exec", "phi", "sleep", "infinity"]]);
  expect(calls.some((call) => call.includes("run"))).toBe(false);
  expect(captureOutput.stdout()).toContain("Phi sandbox phi started.");
});

test("start reuses an already-running sandbox without adding another lease", async () => {
  const leases: string[][] = [];
  await runSandbox(capture().output, ["start", "phi"], {
    env: {},
    which: () => "/fake/sbx",
    startLease: (args) => { leases.push(args); },
    runCommand: async (args) => {
      const command = args.slice(1);
      if (command[0] === "version") {
        return { exitCode: 0, stdout: "v0.42.0-rc2\n", stderr: "" };
      }
      if (command[0] === "ls") {
        return {
          exitCode: 0,
          stdout: JSON.stringify({ sandboxes: [{ name: "phi", agent: "phi", status: "running" }] }),
          stderr: "",
        };
      }
      if (command[0] === "ports") {
        return {
          exitCode: 0,
          stdout: JSON.stringify([{ sandbox_port: 3141, host_port: 49152 }]),
          stderr: "",
        };
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    },
  });

  expect(leases).toEqual([]);
});

test("refuses recursion before invoking sbx", async () => {
  let called = false;
  await expect(runSandbox(capture().output, ["status"], {
    env: { PHI_IN_SANDBOX: "1" },
    which: () => { called = true; return "/fake/sbx"; },
  })).rejects.toThrow("cannot run inside");
  expect(called).toBe(false);
});

test("remove requires confirmation and resolves the exact target", async () => {
  const captureOutput = capture();
  const calls: string[][] = [];
  await runSandbox(captureOutput.output, ["remove", "phi-team", "--confirm"], {
    env: {},
    which: () => "/fake/sbx",
    runCommand: async (args) => {
      calls.push(args);
      const command = args.slice(1);
      if (command[0] === "version") {
        return { exitCode: 0, stdout: "v0.42.0\n", stderr: "" };
      }
      if (command[0] === "ls") {
        return {
          exitCode: 0,
          stdout: JSON.stringify([{ name: "phi-team", agent: "phi" }]),
          stderr: "",
        };
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    },
  });
  expect(calls.at(-1)).toEqual(["/fake/sbx", "rm", "--force", "phi-team"]);
  expect(captureOutput.stdout()).toContain("repositories, worktrees");
});
