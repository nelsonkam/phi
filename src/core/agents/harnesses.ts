import type { HarnessStatus } from "@/shared/types";
import { isCompiledBinary } from "@/version";

// Harnesses phi knows how to launch over ACP. Launch commands land with the
// runtime slice; until then the catalog drives validation and detection.
export const KNOWN_HARNESSES = [
  "claude-code",
  "codex",
  "cursor",
] as const;
export type HarnessId = (typeof KNOWN_HARNESSES)[number];

interface HarnessCatalogEntry {
  id: HarnessId;
  name: string;
  // Binary probed on PATH to decide whether the harness is installed.
  cli: string;
  installHint: string;
  // Terminal command that logs the harness in when ACP reports auth_required.
  loginHint: string;
  // Command that starts the harness speaking ACP over stdio. Absent when no
  // ACP adapter is available yet.
  acpCommand?: (additionalDirectories?: string[]) => string[];
}

const CATALOG: HarnessCatalogEntry[] = [
  {
    id: "claude-code",
    name: "Claude Code",
    cli: "claude",
    installHint: "npm install -g @anthropic-ai/claude-code",
    loginHint: "claude /login",
    // The adapter is a phi dependency; resolve its entry file directly so we
    // run our pinned version, never a same-named package fetched from npm.
    acpCommand: () => isCompiledBinary()
      ? [process.execPath, "__acp-claude"]
      : [
          process.execPath,
          Bun.resolveSync(
            "@agentclientprotocol/claude-agent-acp/dist/index.js",
            import.meta.dir,
          ),
        ],
  },
  {
    id: "codex",
    name: "Codex",
    cli: "codex",
    installHint: "npm install -g @openai/codex",
    loginHint: "codex login",
    acpCommand: () => isCompiledBinary()
      ? [process.execPath, "__acp-codex"]
      : [
          process.execPath,
          Bun.resolveSync(
            "@agentclientprotocol/codex-acp/dist/index.js",
            import.meta.dir,
          ),
        ],
  },
  {
    id: "cursor",
    name: "Cursor CLI",
    // `agent` is Cursor's documented binary name but is too generic to probe
    // safely; `cursor-agent` is the unambiguous alias for the same tool.
    cli: "cursor-agent",
    installHint: "curl https://cursor.com/install -fsS | bash",
    loginHint: "cursor-agent login",
    acpCommand: (additionalDirectories = []) => [
      "cursor-agent",
      ...additionalDirectories.flatMap((directory) => ["--add-dir", directory]),
      "acp",
    ],
  },
];

export function harnessEntry(id: string): HarnessCatalogEntry | null {
  return CATALOG.find((entry) => entry.id === id) ?? null;
}

// Cursor-only ACP extension. Without it, Cursor advertises exploded variant
// IDs such as `grok-4.6[effort=high,fast=true]` and omits the non-fast
// choice. With it, model stays a base ID and `fast` / `effort` become
// separate config options.
const PARAMETERIZED_MODEL_PICKER_META_KEY = "parameterizedModelPicker";

export function acpClientCapabilities(harnessId: string) {
  return {
    fs: { readTextFile: false as const, writeTextFile: false as const },
    ...(harnessId === "cursor"
      ? { _meta: { [PARAMETERIZED_MODEL_PICKER_META_KEY]: true } }
      : {}),
  };
}

// Availability is a live fact about the machine, so it is probed on demand
// and never stored.
export function configuredHarnesses(
  env: NodeJS.ProcessEnv = process.env,
): HarnessId[] {
  const configured = env.PHI_HARNESSES;
  if (configured === undefined) return [...KNOWN_HARNESSES];
  const ids = [
    ...new Set(configured.split(",").map((id) => id.trim()).filter(Boolean)),
  ];
  const unknown = ids.filter(
    (id) => !(KNOWN_HARNESSES as readonly string[]).includes(id),
  );
  if (ids.length === 0 || unknown.length > 0) {
    throw new Error(
      `PHI_HARNESSES must select one or more of ${KNOWN_HARNESSES.join(", ")}`
        + (unknown.length > 0 ? `; unknown: ${unknown.join(", ")}` : ""),
    );
  }
  return ids as HarnessId[];
}

export function detectHarnesses(
  env: NodeJS.ProcessEnv = process.env,
): HarnessStatus[] {
  const selected = new Set(configuredHarnesses(env));
  return CATALOG.filter((entry) => selected.has(entry.id)).map((entry) => ({
    id: entry.id,
    name: entry.name,
    installed: Bun.which(entry.cli) !== null,
    installHint: entry.installHint,
  }));
}
