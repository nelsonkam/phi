import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { CliOutput } from "@/cli";
import {
  isLaunchctlMissing,
  LAUNCHD_LABEL,
  listenUrl,
  parseLaunchctlPrint,
  parseSystemctlShow,
  renderLaunchdPlist,
  renderSystemdUnit,
  runService,
  serveProgramArguments,
  SYSTEMD_UNIT,
} from "@/commands/service";
import { tempDir } from "@/testing/tmpdir";

const homes: string[] = [];

afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

function capture() {
  let stdout = "";
  let stderr = "";
  const output: CliOutput = {
    stdout: (message) => { stdout += message; },
    stderr: (message) => { stderr += message; },
  };
  return {
    output,
    stdout: () => stdout,
    stderr: () => stderr,
  };
}

function homeDir(): string {
  const home = tempDir("phi-service-");
  homes.push(home);
  return home;
}

function linuxUnitPath(home: string): string {
  return join(home, ".config/systemd/user", SYSTEMD_UNIT);
}

function darwinPlistPath(home: string): string {
  return join(home, "Library/LaunchAgents", `${LAUNCHD_LABEL}.plist`);
}

function missingService(target: string) {
  return {
    exitCode: 1,
    stdout: "",
    stderr: `Could not find service "${target}" in domain for uid: 501`,
  };
}

describe("unit rendering", () => {
  test("systemd unit quotes ExecStart and bakes PATH plus bind overrides", () => {
    const unit = renderSystemdUnit({
      programArguments: ["/home/me/.local/bin/phi", "serve"],
      workingDirectory: "/home/me",
      environment: {
        PATH: "/home/me/.local/bin:/usr/bin",
        PHI_HOST: "0.0.0.0",
        PHI_PORT: "43141",
      },
    });

    expect(unit).toContain("ExecStart=/home/me/.local/bin/phi serve");
    expect(unit).toContain("Type=exec");
    expect(unit).toContain("Restart=on-failure");
    expect(unit).toContain("StartLimitBurst=5");
    expect(unit).toContain("WantedBy=default.target");
    expect(unit).toContain('Environment="PATH=/home/me/.local/bin:/usr/bin"');
    expect(unit).toContain('Environment="PHI_HOST=0.0.0.0"');
    expect(unit).toContain('Environment="PHI_PORT=43141"');
    expect(unit).toContain("LimitNOFILE=8192");
  });

  test("launchd plist escapes XML and restarts only after a crash", () => {
    const plist = renderLaunchdPlist({
      programArguments: ["/Users/me/Apps/Phi & Co/phi", "serve"],
      workingDirectory: "/Users/me",
      environment: { PATH: "/opt/homebrew/bin:/usr/bin" },
      logPath: "/Users/me/.phi/logs/server.log",
    });

    expect(plist).toContain(`<string>${LAUNCHD_LABEL}</string>`);
    expect(plist).toContain("<string>/Users/me/Apps/Phi &amp; Co/phi</string>");
    expect(plist).toContain("<string>serve</string>");
    expect(plist).toContain("<key>SuccessfulExit</key>");
    expect(plist).toContain("<false/>");
    expect(plist).toContain("<string>/Users/me/.phi/logs/server.log</string>");
    expect(plist).toContain("<key>NumberOfFiles</key>");
    expect(plist).not.toContain("Phi & Co");
  });

  test("compiled binaries run themselves; source checkouts go through bun", () => {
    expect(
      serveProgramArguments({
        compiled: true,
        execPath: "/opt/phi/phi",
        cliPath: "/opt/phi/src/cli.ts",
      }),
    ).toEqual(["/opt/phi/phi", "serve"]);
    expect(
      serveProgramArguments({
        compiled: false,
        execPath: "/opt/bun/bin/bun",
        cliPath: "/opt/phi/src/cli.ts",
      }),
    ).toEqual(["/opt/bun/bin/bun", "/opt/phi/src/cli.ts", "serve"]);
  });

  test("listen URL follows PHI_HOST and PHI_PORT", () => {
    expect(listenUrl({})).toBe("http://127.0.0.1:3141");
    expect(listenUrl({ PHI_HOST: "0.0.0.0", PHI_PORT: "8080" })).toBe(
      "http://0.0.0.0:8080",
    );
  });

  test("systemd escaping doubles ExecStart dollars and percents without backslash-dollar", () => {
    const unit = renderSystemdUnit({
      programArguments: ["/opt/phi$/bin/phi", "serve"],
      workingDirectory: "/home/%me",
      environment: { PATH: "/opt/%foo:$HOME/bin" },
    });

    expect(unit).toContain('ExecStart="/opt/phi$$/bin/phi" serve');
    expect(unit).toContain('WorkingDirectory="/home/%%me"');
    expect(unit).toContain('Environment="PATH=/opt/%%foo:$HOME/bin"');
    expect(unit).not.toContain("\\$");
  });

  test("generated unit does not trigger systemd escape errors under systemd-analyze", async () => {
    const analyze = Bun.which("systemd-analyze");
    if (!analyze) return;
    const directory = tempDir("phi-systemd-analyze-");
    homes.push(directory);
    const unitPath = join(directory, "phi.service");
    writeFileSync(
      unitPath,
      renderSystemdUnit({
        programArguments: ["/bin/true"],
        workingDirectory: "/tmp",
        environment: { PATH: "/usr/bin:/bin", NOTE: "dollar$and%percent" },
      }),
    );
    const child = Bun.spawn([analyze, "verify", unitPath], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    const output = `${stdout}\n${stderr}`;
    if (exitCode !== 0 && /Failed to connect|No such file or directory/.test(output)) {
      return;
    }
    expect(output).not.toMatch(/Unknown escape|Invalid escape sequence/);
  });
});

describe("status parsers", () => {
  test("systemctl show treats only active as running", () => {
    expect(
      parseSystemctlShow("ActiveState=active\nMainPID=4321\nUnitFileState=enabled\n"),
    ).toEqual({ running: true, pid: 4321, state: "active", failed: false });
    expect(parseSystemctlShow("ActiveState=failed\nMainPID=0\n")).toMatchObject({
      running: false,
      failed: true,
    });
  });

  test("launchctl print reads state and pid", () => {
    expect(
      parseLaunchctlPrint("\tstate = running\n\tpid = 99\n"),
    ).toEqual({ running: true, pid: 99, state: "running", failed: false });
    expect(parseLaunchctlPrint("\tstate = terminated\n\tpid = 0\n")).toMatchObject({
      running: false,
      pid: 0,
    });
  });

  test("launchctl missing matches raced not-found bootouts only", () => {
    expect(
      isLaunchctlMissing({
        exitCode: 113,
        stdout: "",
        stderr: "Boot-out failed: 113: Could not find specified service\n",
      }),
    ).toBe(true);
    expect(
      isLaunchctlMissing({
        exitCode: 3,
        stdout: "",
        stderr: "Boot-out failed: 3: No such process\n",
      }),
    ).toBe(true);
    expect(
      isLaunchctlMissing({
        exitCode: 5,
        stdout: "",
        stderr: "Boot-out failed: 5: Input/output error\n",
      }),
    ).toBe(false);
    expect(
      isLaunchctlMissing({
        exitCode: 1,
        stdout: "",
        stderr: `Could not find service "gui/501/${LAUNCHD_LABEL}" in domain for uid: 501\n`,
      }),
    ).toBe(true);
    expect(
      isLaunchctlMissing({
        exitCode: 1,
        stdout: "",
        stderr: "Could not find service\n",
      }),
    ).toBe(false);
    expect(
      isLaunchctlMissing({
        exitCode: 1,
        stdout: "",
        stderr: "file not found\n",
      }),
    ).toBe(false);
  });
});

describe("linux service command", () => {
  test("install writes a user unit and prints a linger hint", async () => {
    const home = homeDir();
    const calls: string[][] = [];
    const captured = capture();
    const exitCode = await runService(captured.output, ["install"], {
      platform: "linux",
      home,
      execPath: "/opt/phi/phi",
      compiled: true,
      env: {
        HOME: home,
        PATH: "/usr/bin",
        PHI_HOST: "127.0.0.1",
      },
      which: (name) =>
        name === "systemctl" ? "/usr/bin/systemctl"
        : name === "loginctl" ? "/usr/bin/loginctl"
        : null,
      runCommand: async (args) => {
        calls.push(args);
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    });

    expect(exitCode).toBe(0);
    const unit = readFileSync(linuxUnitPath(home), "utf8");
    expect(unit).toContain("ExecStart=/opt/phi/phi serve");
    expect(unit).toContain("Type=exec");
    expect(unit).toContain('Environment="PATH=/opt/phi:/usr/bin"');
    expect(unit).toContain('Environment="PHI_HOST=127.0.0.1"');
    expect(calls).toEqual([
      ["/usr/bin/systemctl", "--user", "daemon-reload"],
      ["/usr/bin/systemctl", "--user", "enable", SYSTEMD_UNIT],
      ["/usr/bin/systemctl", "--user", "restart", SYSTEMD_UNIT],
    ]);
    expect(captured.stdout()).toContain("Installed and started");
    expect(captured.stdout()).toContain("http://127.0.0.1:3141");
    expect(captured.stdout()).toContain("phi service install --linger");
  });

  test("install --linger enables lingering and keeps going if that fails", async () => {
    const home = homeDir();
    const captured = capture();
    const calls: string[][] = [];
    expect(
      await runService(captured.output, ["install", "--linger"], {
        platform: "linux",
        home,
        username: "nelson",
        execPath: "/opt/phi/phi",
        compiled: true,
        env: { HOME: home, PATH: "/usr/bin", USER: "nelson" },
        which: (name) =>
          name === "systemctl" ? "/usr/bin/systemctl"
          : name === "loginctl" ? "/usr/bin/loginctl"
          : null,
        runCommand: async (args) => {
          calls.push(args);
          if (args.includes("enable-linger")) {
            return { exitCode: 1, stdout: "", stderr: "Access denied" };
          }
          return { exitCode: 0, stdout: "Linger=no\n", stderr: "" };
        },
      }),
    ).toBe(0);
    expect(calls).toContainEqual(["/usr/bin/loginctl", "enable-linger", "nelson"]);
    expect(captured.stdout()).toContain("loginctl enable-linger nelson");

    const enabled = capture();
    expect(
      await runService(enabled.output, ["install", "--linger"], {
        platform: "linux",
        home,
        username: "nelson",
        execPath: "/opt/phi/phi",
        compiled: true,
        env: { HOME: home, PATH: "/usr/bin" },
        which: (name) =>
          name === "systemctl" ? "/usr/bin/systemctl"
          : name === "loginctl" ? "/usr/bin/loginctl"
          : null,
        runCommand: async () => ({ exitCode: 0, stdout: "Linger=no\n", stderr: "" }),
      }),
    ).toBe(0);
    expect(enabled.stdout()).toContain("Linger enabled");
  });

  test("start, stop, restart, and uninstall drive systemctl", async () => {
    const home = homeDir();
    mkdirSync(join(home, ".config/systemd/user"), { recursive: true });
    writeFileSync(linuxUnitPath(home), "[Unit]\n");
    const calls: string[][] = [];
    const deps = {
      platform: "linux" as const,
      home,
      execPath: "/opt/phi/phi",
      compiled: true,
      env: { HOME: home },
      which: (name: string) => name === "systemctl" ? "/usr/bin/systemctl" : null,
      runCommand: async (args: string[]) => {
        calls.push(args);
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    };

    expect(await runService(capture().output, ["start"], deps)).toBe(0);
    expect(await runService(capture().output, ["stop"], deps)).toBe(0);
    expect(await runService(capture().output, ["restart"], deps)).toBe(0);
    expect(await runService(capture().output, ["uninstall"], deps)).toBe(0);
    expect(existsSync(linuxUnitPath(home))).toBe(false);
    expect(calls).toEqual([
      ["/usr/bin/systemctl", "--user", "start", SYSTEMD_UNIT],
      ["/usr/bin/systemctl", "--user", "stop", SYSTEMD_UNIT],
      ["/usr/bin/systemctl", "--user", "restart", SYSTEMD_UNIT],
      ["/usr/bin/systemctl", "--user", "disable", "--now", SYSTEMD_UNIT],
      ["/usr/bin/systemctl", "--user", "daemon-reload"],
    ]);
  });

  test("status reports running, failed, and missing units", async () => {
    const home = homeDir();
    const missing = capture();
    expect(
      await runService(missing.output, ["status"], {
        platform: "linux",
        home,
        execPath: "/opt/phi/phi",
        compiled: true,
        env: { HOME: home },
        which: (name) => name === "systemctl" ? "/usr/bin/systemctl" : null,
        runCommand: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
      }),
    ).toBe(1);
    expect(missing.stdout()).toContain("not installed");

    mkdirSync(join(home, ".config/systemd/user"), { recursive: true });
    writeFileSync(linuxUnitPath(home), "[Unit]\n");
    const running = capture();
    expect(
      await runService(running.output, ["status"], {
        platform: "linux",
        home,
        execPath: "/opt/phi/phi",
        compiled: true,
        env: { HOME: home },
        which: (name) => name === "systemctl" ? "/usr/bin/systemctl" : null,
        runCommand: async () => ({
          exitCode: 0,
          stdout: "ActiveState=active\nMainPID=9\nUnitFileState=enabled\n",
          stderr: "",
        }),
      }),
    ).toBe(0);
    expect(running.stdout()).toBe("Phi service is running (pid 9).\n");

    const failed = capture();
    expect(
      await runService(failed.output, ["status"], {
        platform: "linux",
        home,
        execPath: "/opt/phi/phi",
        compiled: true,
        env: { HOME: home },
        which: (name) => name === "systemctl" ? "/usr/bin/systemctl" : null,
        runCommand: async () => ({
          exitCode: 0,
          stdout: "ActiveState=failed\nMainPID=0\n",
          stderr: "",
        }),
      }),
    ).toBe(1);
    expect(failed.stderr()).toContain("journalctl --user -u phi.service");
  });

  test("refuses Linux hosts without systemd", async () => {
    await expect(
      runService(capture().output, ["install"], {
        platform: "linux",
        home: homeDir(),
        execPath: "/opt/phi/phi",
        compiled: true,
        env: {},
        which: () => null,
      }),
    ).rejects.toThrow("systemctl was not found");
  });
});

describe("macos service command", () => {
  test("install writes a LaunchAgent and bootstraps the gui domain", async () => {
    const home = homeDir();
    const calls: string[][] = [];
    const captured = capture();
    const exitCode = await runService(captured.output, ["install"], {
      platform: "darwin",
      home,
      uid: 501,
      execPath: "/Users/me/.local/bin/phi",
      compiled: true,
      env: { HOME: home, PATH: "/opt/homebrew/bin:/usr/bin" },
      which: (name) => name === "launchctl" ? "/bin/launchctl" : null,
      runCommand: async (args) => {
        calls.push(args);
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    });

    expect(exitCode).toBe(0);
    const plist = readFileSync(darwinPlistPath(home), "utf8");
    expect(plist).toContain("/Users/me/.local/bin/phi");
    expect(plist).toContain("<string>serve</string>");
    expect(existsSync(join(home, ".phi/logs"))).toBe(true);
    expect(calls).toEqual([
      ["/bin/launchctl", "bootout", `gui/501/${LAUNCHD_LABEL}`],
      ["/bin/launchctl", "bootout", `user/501/${LAUNCHD_LABEL}`],
      ["/bin/launchctl", "print", "gui/501"],
      ["/bin/launchctl", "bootstrap", "gui/501", darwinPlistPath(home)],
      ["/bin/launchctl", "enable", `gui/501/${LAUNCHD_LABEL}`],
      ["/bin/launchctl", "kickstart", `gui/501/${LAUNCHD_LABEL}`],
    ]);
    expect(captured.stdout()).toContain("Open http://127.0.0.1:3141");
  });

  test("start keeps a job already loaded in the user domain even when gui exists", async () => {
    const home = homeDir();
    mkdirSync(join(home, "Library/LaunchAgents"), { recursive: true });
    writeFileSync(darwinPlistPath(home), "<plist/>");
    const calls: string[][] = [];
    const captured = capture();
    await runService(captured.output, ["start"], {
      platform: "darwin",
      home,
      uid: 501,
      execPath: "/opt/phi/phi",
      compiled: true,
      env: { HOME: home },
      which: (name) => name === "launchctl" ? "/bin/launchctl" : null,
      runCommand: async (args) => {
        calls.push(args);
        if (args[1] === "print" && args[2] === `user/501/${LAUNCHD_LABEL}`) {
          return { exitCode: 0, stdout: "\tstate = running\n\tpid = 42\n", stderr: "" };
        }
        if (args[1] === "print") {
          return missingService(String(args[2]));
        }
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    });

    expect(calls).toEqual([
      ["/bin/launchctl", "print", `gui/501/${LAUNCHD_LABEL}`],
      ["/bin/launchctl", "print", `user/501/${LAUNCHD_LABEL}`],
      ["/bin/launchctl", "kickstart", `user/501/${LAUNCHD_LABEL}`],
    ]);
    expect(calls.some((args) => args[1] === "bootstrap")).toBe(false);
  });

  test("status reports the loaded domain instead of assuming gui", async () => {
    const home = homeDir();
    mkdirSync(join(home, "Library/LaunchAgents"), { recursive: true });
    writeFileSync(darwinPlistPath(home), "<plist/>");
    const captured = capture();
    expect(
      await runService(captured.output, ["status"], {
        platform: "darwin",
        home,
        uid: 501,
        execPath: "/opt/phi/phi",
        compiled: true,
        env: { HOME: home },
        which: (name) => name === "launchctl" ? "/bin/launchctl" : null,
        runCommand: async (args) => {
          if (args[1] === "print" && args[2] === `user/501/${LAUNCHD_LABEL}`) {
            return { exitCode: 0, stdout: "\tstate = running\n\tpid = 42\n", stderr: "" };
          }
          return missingService(String(args[2]));
        },
      }),
    ).toBe(0);
    expect(captured.stdout()).toBe("Phi service is running (pid 42).\n");
  });

  test("stop bootouts both domains instead of sending SIGTERM", async () => {
    const home = homeDir();
    mkdirSync(join(home, "Library/LaunchAgents"), { recursive: true });
    writeFileSync(darwinPlistPath(home), "<plist/>");
    const calls: string[][] = [];
    await runService(capture().output, ["stop"], {
      platform: "darwin",
      home,
      uid: 501,
      execPath: "/opt/phi/phi",
      compiled: true,
      env: { HOME: home },
      which: (name) => name === "launchctl" ? "/bin/launchctl" : null,
      runCommand: async (args) => {
        calls.push(args);
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    });

    expect(calls).toEqual([
      ["/bin/launchctl", "bootout", `gui/501/${LAUNCHD_LABEL}`],
      ["/bin/launchctl", "bootout", `user/501/${LAUNCHD_LABEL}`],
    ]);
    expect(calls.some((args) => args.includes("SIGTERM"))).toBe(false);
    expect(calls.some((args) => args.includes("-k"))).toBe(false);
  });

  test("stop and uninstall fail when a loaded bootout fails", async () => {
    const home = homeDir();
    mkdirSync(join(home, "Library/LaunchAgents"), { recursive: true });
    writeFileSync(darwinPlistPath(home), "<plist/>");
    const deps = {
      platform: "darwin" as const,
      home,
      uid: 501,
      execPath: "/opt/phi/phi",
      compiled: true,
      env: { HOME: home },
      which: (name: string) => name === "launchctl" ? "/bin/launchctl" : null,
      runCommand: async (args: string[]) => {
        if (args[1] === "print" && args[2] === `user/501/${LAUNCHD_LABEL}`) {
          return { exitCode: 0, stdout: "\tstate = running\n\tpid = 42\n", stderr: "" };
        }
        if (args[1] === "print") {
          return missingService(String(args[2]));
        }
        if (args[1] === "bootout") {
          return { exitCode: 5, stdout: "", stderr: "Boot-out failed: 5: Input/output error" };
        }
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    };

    await expect(runService(capture().output, ["stop"], deps)).rejects.toThrow(
      "Input/output error",
    );
    await expect(runService(capture().output, ["uninstall"], deps)).rejects.toThrow(
      "Input/output error",
    );
    expect(existsSync(darwinPlistPath(home))).toBe(true);
  });

  test("stop treats a raced not-found bootout as success", async () => {
    const home = homeDir();
    mkdirSync(join(home, "Library/LaunchAgents"), { recursive: true });
    writeFileSync(darwinPlistPath(home), "<plist/>");
    expect(
      await runService(capture().output, ["stop"], {
        platform: "darwin",
        home,
        uid: 501,
        execPath: "/opt/phi/phi",
        compiled: true,
        env: { HOME: home },
        which: (name) => name === "launchctl" ? "/bin/launchctl" : null,
        runCommand: async (args) => {
          if (args[1] === "print" && args[2] === `user/501/${LAUNCHD_LABEL}`) {
            return { exitCode: 0, stdout: "\tstate = running\n\tpid = 42\n", stderr: "" };
          }
          if (args[1] === "bootout") {
            return {
              exitCode: 113,
              stdout: "",
              stderr: "Boot-out failed: 113: Could not find specified service",
            };
          }
          return missingService(String(args[2]));
        },
      }),
    ).toBe(0);
  });

  test("start fails if the duplicate domain cannot be booted out", async () => {
    const home = homeDir();
    mkdirSync(join(home, "Library/LaunchAgents"), { recursive: true });
    writeFileSync(darwinPlistPath(home), "<plist/>");
    const calls: string[][] = [];
    await expect(
      runService(capture().output, ["start"], {
        platform: "darwin",
        home,
        uid: 501,
        execPath: "/opt/phi/phi",
        compiled: true,
        env: { HOME: home },
        which: (name) => name === "launchctl" ? "/bin/launchctl" : null,
        runCommand: async (args) => {
          calls.push(args);
          if (args[1] === "print") {
            return { exitCode: 0, stdout: "\tstate = running\n\tpid = 7\n", stderr: "" };
          }
          if (args[1] === "bootout") {
            return { exitCode: 5, stdout: "", stderr: "Boot-out failed: 5: Input/output error" };
          }
          return { exitCode: 0, stdout: "", stderr: "" };
        },
      }),
    ).rejects.toThrow("Input/output error");
    expect(calls.some((args) => args[1] === "kickstart")).toBe(false);
  });

  test("install fails when launchctl enable fails", async () => {
    const home = homeDir();
    await expect(
      runService(capture().output, ["install"], {
        platform: "darwin",
        home,
        uid: 501,
        execPath: "/opt/phi/phi",
        compiled: true,
        env: { HOME: home, PATH: "/usr/bin" },
        which: (name) => name === "launchctl" ? "/bin/launchctl" : null,
        runCommand: async (args) => {
          if (args[1] === "print" && String(args[2]).includes(LAUNCHD_LABEL)) {
            return missingService(String(args[2]));
          }
          if (args[1] === "enable") {
            return { exitCode: 1, stdout: "", stderr: "Could not enable service" };
          }
          return { exitCode: 0, stdout: "", stderr: "" };
        },
      }),
    ).rejects.toThrow("Could not enable service");
  });

  test("start bootstraps the user domain when neither target is loaded and no gui session exists", async () => {
    const home = homeDir();
    mkdirSync(join(home, "Library/LaunchAgents"), { recursive: true });
    writeFileSync(darwinPlistPath(home), "<plist/>");
    const calls: string[][] = [];
    await runService(capture().output, ["start"], {
      platform: "darwin",
      home,
      uid: 501,
      execPath: "/opt/phi/phi",
      compiled: true,
      env: { HOME: home },
      which: (name) => name === "launchctl" ? "/bin/launchctl" : null,
      runCommand: async (args) => {
        calls.push(args);
        if (args[1] === "print" && String(args[2]).includes(LAUNCHD_LABEL)) {
          return missingService(String(args[2]));
        }
        if (args[1] === "print") {
          return { exitCode: 1, stdout: "", stderr: "Could not find domain" };
        }
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    });

    expect(calls).toEqual([
      ["/bin/launchctl", "print", `gui/501/${LAUNCHD_LABEL}`],
      ["/bin/launchctl", "print", `user/501/${LAUNCHD_LABEL}`],
      ["/bin/launchctl", "print", "gui/501"],
      ["/bin/launchctl", "bootstrap", "user/501", darwinPlistPath(home)],
      ["/bin/launchctl", "enable", `user/501/${LAUNCHD_LABEL}`],
      ["/bin/launchctl", "kickstart", `user/501/${LAUNCHD_LABEL}`],
    ]);
  });

  test("start and status fail when launchctl print returns an I/O error", async () => {
    const home = homeDir();
    mkdirSync(join(home, "Library/LaunchAgents"), { recursive: true });
    writeFileSync(darwinPlistPath(home), "<plist/>");
    const calls: string[][] = [];
    const deps = {
      platform: "darwin" as const,
      home,
      uid: 501,
      execPath: "/opt/phi/phi",
      compiled: true,
      env: { HOME: home },
      which: (name: string) => name === "launchctl" ? "/bin/launchctl" : null,
      runCommand: async (args: string[]) => {
        calls.push(args);
        if (args[1] === "print") {
          return { exitCode: 1, stdout: "", stderr: "Could not print service: Input/output error" };
        }
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    };

    await expect(runService(capture().output, ["start"], deps)).rejects.toThrow(
      "Input/output error",
    );
    await expect(runService(capture().output, ["status"], deps)).rejects.toThrow(
      "Input/output error",
    );
    expect(calls.some((args) => args[1] === "bootstrap")).toBe(false);
    expect(calls.some((args) => args[1] === "kickstart")).toBe(false);
    expect(calls.some((args) => args[1] === "bootout")).toBe(false);
  });

  test("source checkouts launch bun with the CLI entry", async () => {
    const home = homeDir();
    await runService(capture().output, ["install"], {
      platform: "darwin",
      home,
      uid: 501,
      execPath: "/opt/bun/bin/bun",
      compiled: false,
      cliPath: "/src/cli.ts",
      env: { HOME: home, PATH: "/usr/bin" },
      which: (name) => name === "launchctl" ? "/bin/launchctl" : null,
      runCommand: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
    });

    const plist = readFileSync(darwinPlistPath(home), "utf8");
    expect(plist).toContain("<string>/opt/bun/bin/bun</string>");
    expect(plist).toContain("<string>/src/cli.ts</string>");
    expect(plist).toContain("<string>serve</string>");
  });
});

describe("service command guards", () => {
  test("prints help without touching the supervisor", async () => {
    const captured = capture();
    let ran = false;
    expect(
      await runService(captured.output, ["help"], {
        runCommand: async () => {
          ran = true;
          return { exitCode: 0, stdout: "", stderr: "" };
        },
      }),
    ).toBe(0);
    expect(ran).toBe(false);
    expect(captured.stdout()).toContain("Usage: phi service <command>");
    expect(captured.stdout()).toContain("install [--linger]");
  });

  test("rejects unsupported platforms and sandbox use", async () => {
    await expect(
      runService(capture().output, ["install"], { platform: "win32" }),
    ).rejects.toThrow("only supported on macOS and Linux");
    await expect(
      runService(capture().output, ["install"], {
        env: { PHI_IN_SANDBOX: "1" },
      }),
    ).rejects.toThrow("inside a Phi sandbox");
    await expect(
      runService(capture().output, ["install", "--linger"], { platform: "darwin" }),
    ).rejects.toThrow("--linger is only supported on Linux");
  });

  test("start requires an installed definition and rejects extra arguments", async () => {
    await expect(
      runService(capture().output, ["start"], {
        platform: "linux",
        home: homeDir(),
        execPath: "/opt/phi/phi",
        compiled: true,
        env: {},
        which: (name) => name === "systemctl" ? "/usr/bin/systemctl" : null,
        runCommand: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
      }),
    ).rejects.toThrow("Phi service is not installed");
    await expect(
      runService(capture().output, ["install", "--user"], {
        platform: "linux",
        home: homeDir(),
        execPath: "/opt/phi/phi",
        compiled: true,
        env: {},
        which: (name) => name === "systemctl" ? "/usr/bin/systemctl" : null,
      }),
    ).rejects.toThrow("Usage: phi service install [--linger]");
  });
});
