import { Database } from "bun:sqlite";
import { chmodSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { now } from "../ids.ts";

const migrations = [
  "001_initial.sql",
  "002_job_models.sql",
  "003_drop_outbox_delivery.sql",
  "004_simplify_schema.sql",
] as const;

export const schemaVersion = migrations.length;

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
    // Rebuilding tables in later migrations requires dropping parents that
    // other tables reference, so enforcement is off for the duration.
    this.raw.exec("PRAGMA foreign_keys = OFF");
    try {
      for (const [index, file] of migrations.entries()) {
        const version = index + 1;
        if (versions.has(version)) continue;
        const sql = readFileSync(
          join(import.meta.dir, "migrations", file),
          "utf8",
        );
        this.immediate(() => {
          this.raw.exec(sql);
          this.raw
            .query(
              "INSERT INTO schema_migrations(version, applied_at) VALUES(?, ?)",
            )
            .run(version, now());
        });
      }
    } finally {
      this.raw.exec("PRAGMA foreign_keys = ON");
    }
  }

  immediate<T>(fn: () => T): T {
    return this.raw.transaction(fn).immediate();
  }

  close(): void {
    this.raw.close();
  }
}
