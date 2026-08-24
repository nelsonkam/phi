import { Database } from "bun:sqlite";
import { chmodSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { now } from "../ids.ts";

export class PhiDatabase {
  readonly raw: Database;

  constructor(readonly path: string) {
    this.raw = new Database(path, { create: true, strict: true });
    this.raw.exec("PRAGMA journal_mode = WAL");
    this.raw.exec("PRAGMA foreign_keys = ON");
    this.raw.exec("PRAGMA synchronous = NORMAL");
    this.raw.exec("PRAGMA busy_timeout = 5000");
    chmodSync(path, 0o600);
  }

  migrate(): void {
    this.raw.exec(
      "CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL) STRICT",
    );
    const applied = this.raw
      .query("SELECT version FROM schema_migrations")
      .all() as { version: number }[];
    const versions = new Set(applied.map((row) => row.version));
    if (!versions.has(1)) {
      const sql = readFileSync(
        join(import.meta.dir, "migrations", "001_initial.sql"),
        "utf8",
      );
      this.immediate(() => {
        this.raw.exec(sql);
        this.raw
          .query(
            "INSERT INTO schema_migrations(version, applied_at) VALUES(1, ?)",
          )
          .run(now());
      });
    }
  }

  immediate<T>(fn: () => T): T {
    return this.raw.transaction(fn).immediate();
  }

  close(): void {
    this.raw.close();
  }
}
