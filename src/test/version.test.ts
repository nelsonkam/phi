import { expect, test } from "bun:test";
import { releaseAssetName, RELEASE_TARGETS } from "@/version";

test("publishes standalone assets for macOS and Linux on both architectures", () => {
  expect(RELEASE_TARGETS.map((target) => target.asset)).toEqual([
    "phi-darwin-arm64",
    "phi-darwin-x64",
    "phi-linux-arm64",
    "phi-linux-x64",
  ]);
  expect(releaseAssetName("linux", "arm64")).toBe("phi-linux-arm64");
  expect(releaseAssetName("linux", "x64")).toBe("phi-linux-x64");
});
