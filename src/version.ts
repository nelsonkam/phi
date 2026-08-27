import { basename } from "node:path";

import packageJson from "../package.json" with { type: "json" };

export const VERSION: string = packageJson.version;

/** GitHub repository that publishes binaries consumed by `phi update`. */
export const UPDATE_REPO: string = process.env.PHI_UPDATE_REPO ?? "nelsonkam/phi";

export const RELEASE_TARGETS = [
  { target: "bun-darwin-arm64", asset: "phi-darwin-arm64" },
  { target: "bun-darwin-x64", asset: "phi-darwin-x64" },
] as const;

export function releaseAssetName(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): string {
  const name = `phi-${platform}-${arch}`;
  if (!RELEASE_TARGETS.some((entry) => entry.asset === name)) {
    throw new Error(`No release binary is published for ${platform}/${arch}`);
  }
  return name;
}

/** Whether phi is running as a Bun-compiled executable. */
export function isCompiledBinary(execPath = process.execPath): boolean {
  return !/^bun(?:\.exe)?$/i.test(basename(execPath));
}
