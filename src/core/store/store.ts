import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { migrate } from "../../db/migrate";
import type { Channel, Workspace } from "../../shared/types";

const DEFAULT_WORKSPACE_ID = "ws_default";
const DEFAULT_CHANNEL_ID = "ch_general";

export function defaultDbPath(): string {
  return process.env.PHI_DB ?? join(homedir(), ".phi", "phi.db");
}

export class PhiStore {
  readonly db: Database;

  constructor(path: string = defaultDbPath()) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path, { create: true, strict: true });
    this.db.run("PRAGMA journal_mode = WAL;");
    this.db.run("PRAGMA foreign_keys = ON;");
    this.db.run("PRAGMA busy_timeout = 5000;");
    migrate(this.db);
    this.seedDefaults();
  }

  private seedDefaults(): void {
    const now = new Date().toISOString();
    this.db
      .query(
        `INSERT OR IGNORE INTO workspaces (id, name, root_path, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(DEFAULT_WORKSPACE_ID, "default", process.cwd(), now, now);
    this.db
      .query(
        `INSERT OR IGNORE INTO channels (id, workspace_id, name, purpose, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(DEFAULT_CHANNEL_ID, DEFAULT_WORKSPACE_ID, "general", null, now, now);
  }

  defaultWorkspace(): Workspace {
    const row = this.db
      .query<WorkspaceRow, [string]>("SELECT * FROM workspaces WHERE id = ?")
      .get(DEFAULT_WORKSPACE_ID);
    if (!row) throw new Error("default workspace missing");
    return workspaceFromRow(row);
  }

  listChannels(workspaceId: string): Channel[] {
    return this.db
      .query<ChannelRow, [string]>(
        "SELECT * FROM channels WHERE workspace_id = ? ORDER BY name",
      )
      .all(workspaceId)
      .map(channelFromRow);
  }

  close(): void {
    this.db.close();
  }
}

interface WorkspaceRow {
  id: string;
  name: string;
  root_path: string;
  created_at: string;
  updated_at: string;
}

interface ChannelRow {
  id: string;
  workspace_id: string;
  name: string;
  purpose: string | null;
  created_at: string;
  updated_at: string;
}

function workspaceFromRow(row: WorkspaceRow): Workspace {
  return {
    id: row.id,
    name: row.name,
    rootPath: row.root_path,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function channelFromRow(row: ChannelRow): Channel {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    name: row.name,
    purpose: row.purpose,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
