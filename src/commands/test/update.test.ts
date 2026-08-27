import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { CliOutput } from "@/cli";
import {
  downloadAsset,
  fetchLatestRelease,
  type LatestRelease,
  type Release,
  type ReleaseAsset,
  runUpdate,
} from "@/commands/update";
import { UPDATE_REPO } from "@/version";

const ASSET: ReleaseAsset = {
  name: "phi-darwin-arm64",
  url: "https://api.github.test/assets/1",
  browser_download_url: "https://github.test/download/phi-darwin-arm64",
  size: 6,
};
const RELEASE: Release = {
  tag_name: "v9.9.9",
  html_url: "https://github.test/releases/v9.9.9",
  assets: [ASSET],
};

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function temporaryPath(name: string): string {
  const directory = mkdtempSync(join(tmpdir(), "phi-update-test-"));
  temporaryDirectories.push(directory);
  return join(directory, name);
}

function captureOutput(): { output: CliOutput; stdout(): string; stderr(): string } {
  let stdout = "";
  let stderr = "";
  return {
    output: {
      stdout: (message) => { stdout += message; },
      stderr: (message) => { stderr += message; },
    },
    stdout: () => stdout,
    stderr: () => stderr,
  };
}

describe("release lookup", () => {
  test("reads a public latest release without invoking gh", async () => {
    const commands: string[][] = [];
    const latest = await fetchLatestRelease({
      env: {},
      fetch: async () => Response.json(RELEASE),
      which: () => "/usr/bin/gh",
      runCommand: async (args) => {
        commands.push(args);
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    });

    expect(latest.release.tag_name).toBe("v9.9.9");
    expect(latest.source.kind).toBe("public");
    expect(latest.repo).toBe(UPDATE_REPO);
    expect(commands).toEqual([]);
  });

  test("uses GITHUB_TOKEN for private release metadata", async () => {
    let authorization = "";
    const latest = await fetchLatestRelease({
      env: { GITHUB_TOKEN: "secret-token" },
      fetch: async (_input, init) => {
        authorization = new Headers(init?.headers).get("authorization") ?? "";
        return Response.json(RELEASE);
      },
    });

    expect(authorization).toBe("Bearer secret-token");
    expect(latest.source.kind).toBe("token");
  });

  test("falls back to authenticated gh when HTTP credentials cannot read the repo", async () => {
    const commands: string[][] = [];
    const latest = await fetchLatestRelease({
      env: {},
      fetch: async () => new Response("Not Found", { status: 404 }),
      which: () => "/usr/bin/gh",
      runCommand: async (args) => {
        commands.push(args);
        return { exitCode: 0, stdout: JSON.stringify(RELEASE), stderr: "" };
      },
    });

    expect(latest.source.kind).toBe("gh");
    expect(commands).toEqual([["gh", "api", `repos/${UPDATE_REPO}/releases/latest`]]);
  });

  test("uses the update repository from the injected environment", async () => {
    let requested = "";
    const latest = await fetchLatestRelease({
      env: { PHI_UPDATE_REPO: "example/private-phi" },
      fetch: async (input) => {
        requested = String(input);
        return Response.json(RELEASE);
      },
    });

    expect(requested).toContain("repos/example/private-phi/releases/latest");
    expect(latest.repo).toBe("example/private-phi");
  });
});

describe("release download", () => {
  test("downloads a public asset directly", async () => {
    const path = temporaryPath("asset");
    const latest: LatestRelease = {
      release: RELEASE,
      source: { kind: "public" },
      repo: UPDATE_REPO,
    };
    await downloadAsset(latest, ASSET, path, {
      fetch: async (input) => {
        expect(String(input)).toBe(ASSET.browser_download_url);
        return new Response("binary");
      },
    });

    expect(await Bun.file(path).text()).toBe("binary");
  });

  test("uses the asset API and token for a private release", async () => {
    const path = temporaryPath("asset");
    const progress: number[] = [];
    const latest: LatestRelease = {
      release: RELEASE,
      source: { kind: "token", token: "secret-token" },
      repo: UPDATE_REPO,
    };
    await downloadAsset(latest, ASSET, path, {
      fetch: async (input, init) => {
        expect(String(input)).toBe(ASSET.url!);
        expect(new Headers(init?.headers).get("authorization")).toBe("Bearer secret-token");
        expect(new Headers(init?.headers).get("accept")).toBe("application/octet-stream");
        const encoder = new TextEncoder();
        return new Response(new ReadableStream({
          start(controller) {
            controller.enqueue(encoder.encode("bin"));
            controller.enqueue(encoder.encode("ary"));
            controller.close();
          },
        }));
      },
      onDownloadProgress: (downloadedBytes) => progress.push(downloadedBytes),
    });

    expect(await Bun.file(path).text()).toBe("binary");
    expect(progress).toEqual([3, 6]);
  });

  test("fails a response body that stops producing bytes", async () => {
    const path = temporaryPath("asset");
    const latest: LatestRelease = {
      release: RELEASE,
      source: { kind: "public" },
      repo: UPDATE_REPO,
    };

    expect(downloadAsset(latest, ASSET, path, {
      fetch: async () => new Response(new ReadableStream({ start() {} })),
      downloadStallTimeoutMs: 10,
    })).rejects.toThrow("Download stalled");
  });
});

describe("update command", () => {
  test("rejects unknown arguments", async () => {
    const capture = captureOutput();
    expect(runUpdate(capture.output, { compiled: true, env: {} }, ["--channel", "canary"]))
      .rejects.toThrow("Unknown argument");
  });

  test("rejects source checkouts before making a network request", async () => {
    const capture = captureOutput();
    let fetched = false;
    const exitCode = await runUpdate(capture.output, {
      compiled: false,
      env: {},
      fetch: async () => {
        fetched = true;
        return Response.json(RELEASE);
      },
    });

    expect(exitCode).toBe(1);
    expect(fetched).toBe(false);
    expect(capture.stderr()).toContain("source checkout");
  });

  test("downloads and atomically replaces the matching executable", async () => {
    const capture = captureOutput();
    const executablePath = temporaryPath("phi");
    await Bun.write(executablePath, "old");
    let replaced: [string, string] | undefined;

    const exitCode = await runUpdate(capture.output, {
      compiled: true,
      env: {},
      execPath: executablePath,
      platform: "darwin",
      arch: "arm64",
      fetch: async (input) => String(input).includes("releases/latest")
        ? Response.json(RELEASE)
        : new Response("binary"),
      replaceExecutable: (stagingPath, destinationPath) => {
        replaced = [stagingPath, destinationPath];
      },
    });

    expect(exitCode).toBe(0);
    expect(replaced?.[1]).toBe(executablePath);
    expect(await Bun.file(replaced![0]).text()).toBe("binary");
    expect(capture.stdout()).toContain("(100%)");
    expect(capture.stdout()).toContain("Updated to v9.9.9");
  });

  test("rejects a truncated asset without replacing the executable", async () => {
    const capture = captureOutput();
    const executablePath = temporaryPath("phi");
    await Bun.write(executablePath, "old");
    let replaced = false;

    expect(runUpdate(capture.output, {
      compiled: true,
      env: {},
      execPath: executablePath,
      platform: "darwin",
      arch: "arm64",
      fetch: async (input) => String(input).includes("releases/latest")
        ? Response.json(RELEASE)
        : new Response("short"),
      replaceExecutable: () => { replaced = true; },
    })).rejects.toThrow("expected 6");
    expect(replaced).toBe(false);
  });
});
