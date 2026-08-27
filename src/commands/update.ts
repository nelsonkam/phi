import { chmodSync, renameSync, statSync, unlinkSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { randomUUID } from "node:crypto";

import type { CliOutput } from "@/cli";
import {
  isCompiledBinary,
  releaseAssetName,
  UPDATE_REPO,
  VERSION,
} from "@/version";

export interface ReleaseAsset {
  name: string;
  url?: string;
  browser_download_url: string;
  size: number;
}

export interface Release {
  tag_name: string;
  html_url: string;
  assets: ReleaseAsset[];
  draft?: boolean;
  prerelease?: boolean;
}

interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

type HttpFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

interface UpdateDependencies {
  env?: NodeJS.ProcessEnv;
  fetch?: HttpFetch;
  which?: typeof Bun.which;
  runCommand?: (args: string[]) => Promise<CommandResult>;
  downloadStallTimeoutMs?: number;
  onDownloadProgress?: (downloadedBytes: number) => void;
  compiled?: boolean;
  execPath?: string;
  platform?: NodeJS.Platform;
  arch?: string;
  replaceExecutable?: (stagingPath: string, executablePath: string) => void;
}

type ReleaseSource =
  | { kind: "public" }
  | { kind: "token"; token: string }
  | { kind: "gh" };

export interface LatestRelease {
  release: Release;
  source: ReleaseSource;
  repo: string;
}

const DOWNLOAD_STALL_TIMEOUT_MS = 60_000;
const LATEST_RELEASE_PATH = (repo: string) => `repos/${repo}/releases/latest`;

function needsAuthentication(status: number): boolean {
  return status === 401 || status === 403 || status === 404;
}

async function defaultRunCommand(args: string[]): Promise<CommandResult> {
  const child = Bun.spawn(args, { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}

function requireGh(which: typeof Bun.which, repo: string): void {
  if (which("gh")) return;
  throw new Error(
    `${repo} is not readable with the configured GitHub credentials. `
      + "Install GitHub CLI (https://cli.github.com) and run `gh auth login`, or set "
      + "PHI_UPDATE_REPO to a repository that publishes the release binaries.",
  );
}

async function fetchLatestReleaseWithGh(
  repo: string,
  which: typeof Bun.which,
  runCommand: (args: string[]) => Promise<CommandResult>,
): Promise<Release> {
  requireGh(which, repo);
  const result = await runCommand(["gh", "api", LATEST_RELEASE_PATH(repo)]);
  if (result.exitCode !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim() || "unknown error";
    throw new Error(
      `gh could not read releases for ${repo}: ${detail}\n`
        + "Run `gh auth login` if you have access to the repository.",
    );
  }
  return JSON.parse(result.stdout) as Release;
}

export async function fetchLatestRelease(
  dependencies: Pick<UpdateDependencies, "env" | "fetch" | "which" | "runCommand"> = {},
): Promise<LatestRelease> {
  const env = dependencies.env ?? process.env;
  const http = dependencies.fetch ?? fetch;
  const which = dependencies.which ?? Bun.which;
  const runCommand = dependencies.runCommand ?? defaultRunCommand;
  const token = env.GITHUB_TOKEN?.trim();
  const repo = env.PHI_UPDATE_REPO?.trim() || UPDATE_REPO;
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "User-Agent": `phi/${VERSION}`,
    "X-GitHub-Api-Version": "2022-11-28",
  };
  if (token) headers.Authorization = `Bearer ${token}`;

  const response = await http(`https://api.github.com/${LATEST_RELEASE_PATH(repo)}`, {
    headers,
  });
  if (response.ok) {
    return {
      release: (await response.json()) as Release,
      source: token ? { kind: "token", token } : { kind: "public" },
      repo,
    };
  }
  if (needsAuthentication(response.status)) {
    return {
      release: await fetchLatestReleaseWithGh(repo, which, runCommand),
      source: { kind: "gh" },
      repo,
    };
  }
  throw new Error(`GitHub API returned ${response.status} ${response.statusText}`);
}

async function downloadWithGh(
  repo: string,
  release: Release,
  asset: ReleaseAsset,
  stagingPath: string,
  which: typeof Bun.which,
  runCommand: (args: string[]) => Promise<CommandResult>,
): Promise<void> {
  requireGh(which, repo);
  const result = await runCommand([
    "gh",
    "release",
    "download",
    release.tag_name,
    "--repo",
    repo,
    "--pattern",
    asset.name,
    "--output",
    stagingPath,
    "--clobber",
  ]);
  if (result.exitCode !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim() || "unknown error";
    throw new Error(`gh could not download ${asset.name} from ${release.tag_name}: ${detail}`);
  }
}

async function readWithStallTimeout(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  timeoutMs: number,
) {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      reader.read(),
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(
          () => reject(new Error(`Download stalled for ${Math.ceil(timeoutMs / 1_000)} seconds.`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

async function streamResponseToFile(
  response: Response,
  stagingPath: string,
  stallTimeoutMs: number,
  onProgress?: (downloadedBytes: number) => void,
): Promise<void> {
  if (!response.body) throw new Error("Download returned an empty response body.");

  const reader = response.body.getReader();
  const writer = Bun.file(stagingPath).writer({ highWaterMark: 1024 * 1024 });
  let downloadedBytes = 0;
  let ended = false;
  try {
    while (true) {
      const { done, value } = await readWithStallTimeout(reader, stallTimeoutMs);
      if (done) break;
      await writer.write(value);
      downloadedBytes += value.byteLength;
      onProgress?.(downloadedBytes);
    }
    await writer.end();
    ended = true;
  } catch (error) {
    try {
      await reader.cancel(error);
    } catch {
      // Preserve the download or write error that caused cancellation.
    }
    if (!ended) {
      try {
        await writer.end(error instanceof Error ? error : new Error(String(error)));
      } catch {
        // Preserve the original error; the caller removes the staging file.
      }
    }
    throw error;
  } finally {
    reader.releaseLock();
  }
}

export async function downloadAsset(
  latest: LatestRelease,
  asset: ReleaseAsset,
  stagingPath: string,
  dependencies: Pick<
    UpdateDependencies,
    "fetch" | "which" | "runCommand" | "downloadStallTimeoutMs" | "onDownloadProgress"
  > = {},
): Promise<void> {
  const http = dependencies.fetch ?? fetch;
  const which = dependencies.which ?? Bun.which;
  const runCommand = dependencies.runCommand ?? defaultRunCommand;
  if (latest.source.kind === "gh") {
    return downloadWithGh(latest.repo, latest.release, asset, stagingPath, which, runCommand);
  }

  const headers: Record<string, string> = { "User-Agent": `phi/${VERSION}` };
  let url = asset.browser_download_url;
  if (latest.source.kind === "token" && asset.url) {
    url = asset.url;
    headers.Accept = "application/octet-stream";
    headers.Authorization = `Bearer ${latest.source.token}`;
    headers["X-GitHub-Api-Version"] = "2022-11-28";
  }

  const response = await http(url, { headers });
  if (needsAuthentication(response.status)) {
    return downloadWithGh(latest.repo, latest.release, asset, stagingPath, which, runCommand);
  }
  if (!response.ok) throw new Error(`Download failed: ${response.status} ${response.statusText}`);
  await streamResponseToFile(
    response,
    stagingPath,
    dependencies.downloadStallTimeoutMs ?? DOWNLOAD_STALL_TIMEOUT_MS,
    dependencies.onDownloadProgress,
  );
}

function normalizeVersion(tag: string): string {
  return tag.replace(/^v/, "").trim();
}

export async function runUpdate(
  output: CliOutput,
  dependencies: UpdateDependencies = {},
  args: string[] = [],
): Promise<number> {
  if (args.length > 0) {
    throw new Error(`Unknown argument "${args[0]}". Usage: phi update`);
  }
  const env = dependencies.env ?? process.env;
  if (!(dependencies.compiled ?? isCompiledBinary(dependencies.execPath))) {
    output.stderr(
      "`phi update` only works for the compiled binary. "
        + "This is a source checkout — use `git pull && bun install` instead.\n",
    );
    return 1;
  }

  output.stdout(`Current version: v${VERSION}\n`);
  const latest = await fetchLatestRelease({ ...dependencies, env });
  const version = normalizeVersion(latest.release.tag_name);
  if (version === VERSION) {
    output.stdout(`Already up to date (latest release is ${latest.release.tag_name}).\n`);
    return 0;
  }

  const assetName = releaseAssetName(dependencies.platform, dependencies.arch);
  const asset = latest.release.assets.find((candidate) => candidate.name === assetName);
  if (!asset) {
    throw new Error(
      `Release ${latest.release.tag_name} has no asset named ${assetName}. `
        + `See ${latest.release.html_url}`,
    );
  }

  output.stdout(
    `Downloading ${assetName} ${latest.release.tag_name} `
      + `(${(asset.size / 1024 / 1024).toFixed(1)} MB)...\n`,
  );
  let lastReportedPercent = 0;
  const reportProgress = (downloadedBytes: number): void => {
    const percent = Math.min(100, Math.floor(downloadedBytes / asset.size * 100));
    if (percent < 100 && percent < lastReportedPercent + 10) return;
    lastReportedPercent = percent;
    output.stdout(
      `Downloaded ${(downloadedBytes / 1024 / 1024).toFixed(1)} MB `
        + `of ${(asset.size / 1024 / 1024).toFixed(1)} MB (${percent}%).\n`,
    );
  };
  const executablePath = dependencies.execPath ?? process.execPath;
  const stagingPath = resolve(dirname(executablePath), `.${assetName}.${randomUUID()}.download`);
  try {
    await downloadAsset(latest, asset, stagingPath, {
      ...dependencies,
      onDownloadProgress: dependencies.onDownloadProgress ?? reportProgress,
    });
    const downloadedSize = statSync(stagingPath).size;
    if (downloadedSize !== asset.size) {
      throw new Error(
        `Downloaded ${downloadedSize} bytes for ${assetName}; expected ${asset.size}.`,
      );
    }
    chmodSync(stagingPath, 0o755);
    (dependencies.replaceExecutable ?? renameSync)(stagingPath, executablePath);
  } catch (error) {
    try {
      unlinkSync(stagingPath);
    } catch {
      // The download may not have created the staging file, or rename already consumed it.
    }
    throw error;
  }

  output.stdout(`Updated to ${latest.release.tag_name}.\n`);
  output.stdout("Restart phi to run the new version.\n");
  return 0;
}
