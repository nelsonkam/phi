import type { HarnessStatus } from "@/shared/types";

// Harnesses phi knows how to launch over ACP. Launch commands land with the
// runtime slice; until then the catalog drives validation and detection.
export const KNOWN_HARNESSES = [
  "claude-code",
  "gemini",
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
  acpCommand?: () => string[];
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
    acpCommand: () => [
      process.execPath,
      Bun.resolveSync(
        "@agentclientprotocol/claude-agent-acp/dist/index.js",
        import.meta.dir,
      ),
    ],
  },
  {
    id: "gemini",
    name: "Gemini CLI",
    cli: "gemini",
    installHint: "npm install -g @google/gemini-cli",
    loginHint: "gemini",
    acpCommand: () => ["gemini", "--experimental-acp"],
  },
  {
    id: "codex",
    name: "Codex",
    cli: "codex",
    installHint: "npm install -g @openai/codex",
    loginHint: "codex login",
    acpCommand: () => [
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
    acpCommand: () => ["cursor-agent", "acp"],
  },
];

export function harnessEntry(id: string): HarnessCatalogEntry | null {
  return CATALOG.find((entry) => entry.id === id) ?? null;
}

// Availability is a live fact about the machine, so it is probed on demand
// and never stored.
export function detectHarnesses(): HarnessStatus[] {
  return CATALOG.map((entry) => ({
    id: entry.id,
    name: entry.name,
    installed: Bun.which(entry.cli) !== null,
    installHint: entry.installHint,
  }));
}
