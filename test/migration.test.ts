import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PhiDatabase, schemaVersion } from "../src/db/database.ts";

test("schema 1 runtime databases gain durable job model selection", () => {
  const root = mkdtempSync(join(tmpdir(), "phi-migration-test-"));
  const database = new PhiDatabase(join(root, "runtime.db"));
  try {
    database.raw.exec(
      "CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL) STRICT",
    );
    database.raw.exec(
      readFileSync(
        join(
          import.meta.dir,
          "..",
          "src",
          "db",
          "migrations",
          "001_initial.sql",
        ),
        "utf8",
      ),
    );
    database.raw
      .query("INSERT INTO schema_migrations(version, applied_at) VALUES(1, ?)")
      .run(new Date().toISOString());

    database.migrate();

    const columns = database.raw.query("PRAGMA table_info(jobs)").all() as {
      name: string;
    }[];
    expect(columns.map((column) => column.name)).toContain("model");
    expect(columns.map((column) => column.name)).toContain("effort");
    expect(
      database.raw
        .query("SELECT max(version) AS version FROM schema_migrations")
        .get(),
    ).toEqual({ version: schemaVersion });
  } finally {
    database.close();
  }
});
