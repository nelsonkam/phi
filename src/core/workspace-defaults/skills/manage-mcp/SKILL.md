---
name: manage-mcp
description: Add, update, disable, or remove workspace MCP servers in `.agents/mcp.json`. Use when the user wants to add an MCP server, connect a tool server, edit mcp.json, or configure stdio, HTTP, or SSE MCP.
---

# Manage workspace MCP servers

Workspace MCP servers live in `.agents/mcp.json`. Edit that file; do not put
MCP config in agent definitions or channel folders. Create the file if it is
missing. Phi reads it before each turn and replaces the ACP session when the
resolved server list changes.

```json
{
  "mcpServers": {
    "github": {
      "url": "https://example.com/mcp",
      "headers": {
        "Authorization": "Bearer ${env:GITHUB_TOKEN}"
      }
    },
    "local-tools": {
      "command": "npx",
      "args": ["-y", "mcp-server"],
      "env": {
        "API_KEY": "${env:LOCAL_TOOLS_API_KEY}"
      }
    }
  }
}
```

- The top-level object accepts only `mcpServers`.
- Names start with a letter or number, then letters, numbers, `_`, or `-`.
  `phi` is reserved case-insensitively (`PHI` fails too). Duplicate names fail
  the turn.
- Stdio servers set `command` and may set `args` and `env`. `command` may be a
  PATH name, an absolute path, or a path relative to the workspace. Do not set
  `url` on the same server.
- Remote servers set `url` and may set `headers`. Transport defaults to
  streamable HTTP. Set `"type": "sse"` when the endpoint is SSE. Do not set
  `command` on the same server.
- `"type": "stdio" | "http" | "sse"` is optional when `command` or `url` is
  present. `"disabled": true` skips a server without deleting it; a disabled
  entry may omit `command` and `url`. To suppress the sandbox gateway, use
  `"sbx": { "disabled": true }`.
- Interpolate with `${env:NAME}` or `${NAME}`, plus `${userHome}`,
  `${workspaceFolder}`, `${workspaceFolderBasename}`, `${pathSeparator}`, and
  `${/}`. Keep secrets out of the file: reference environment variables that
  are already set in Phi's process environment. Missing variables fail the
  turn. Interpolated headers require `https://` (or `http://` on localhost).
- `envFile` and `auth` are unsupported keys; the schema rejects them. There is
  no MCP login or other auth shape.
- Inside a Docker sandbox, Phi auto-registers an HTTP server named `sbx`. A
  user `sbx` entry overrides that gateway; use the disable example above to
  turn it off.

When adding or enabling a server, confirm the command or URL with the user
if it is not specified. After editing, tell them the server name and that
the next agent turn will pick it up.
