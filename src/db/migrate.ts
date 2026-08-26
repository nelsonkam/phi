import type { Database } from "bun:sqlite";
import m001 from "./migrations/001_init.sql" with { type: "text" };
import m002 from "./migrations/002_thread_turn_state.sql" with { type: "text" };
import m003 from "./migrations/003_thread_sessions.sql" with { type: "text" };
import m004 from "./migrations/004_message_search.sql" with { type: "text" };
import m005 from "./migrations/005_multi_agent.sql" with { type: "text" };

// Explicit list keeps migrations ordered and bundle-safe (no directory scan).
const MIGRATIONS: Array<{ id: string; sql: string }> = [
  { id: "001_init", sql: m001 },
  { id: "002_thread_turn_state", sql: m002 },
  { id: "003_thread_sessions", sql: m003 },
  { id: "004_message_search", sql: m004 },
  { id: "005_multi_agent", sql: m005 },
];

export function migrate(db: Database): void {
  db.run(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL
    );
  `);

  const applied = new Set(
    db
      .query<{ id: string }, []>("SELECT id FROM schema_migrations")
      .all()
      .map((row) => row.id),
  );

  for (const migration of MIGRATIONS) {
    if (applied.has(migration.id)) continue;
    db.transaction(() => {
      db.run(migration.sql);
      db.query("INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)").run(
        migration.id,
        new Date().toISOString(),
      );
    })();
  }
}
