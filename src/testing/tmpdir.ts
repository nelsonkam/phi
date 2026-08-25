import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Fresh directory under the OS temp dir, outside the project tree.
export function tempDir(prefix = "phi-test-"): string {
  return mkdtempSync(join(tmpdir(), prefix));
}
