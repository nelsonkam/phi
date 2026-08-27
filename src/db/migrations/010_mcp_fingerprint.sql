ALTER TABLE thread_agent_sessions
  ADD COLUMN mcp_fingerprint TEXT NOT NULL DEFAULT 'absent';
