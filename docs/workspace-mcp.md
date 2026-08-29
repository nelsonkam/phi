# Workspace MCP servers

Phi loads optional user-defined MCP connections from `.agents/mcp.json` in
the managed workspace. The file uses the same `mcpServers` shape as Cursor and
Claude: a stdio server has `command`, a remote server has `url`. Those servers
are announced to every agent session in addition to Phi's internal `phi` MCP
server.

Inside a Docker sandbox (`PHI_IN_SANDBOX=1`), Phi also auto-registers the
sandbox's MCP gateway as an HTTP server named `sbx` when sandboxd injects
`MCP_GATEWAY_URL` and `MCP_SENTINEL_TOKEN_NAME`. The sentinel name is not a
credential; the host proxy substitutes the real token per request. A harness
without HTTP MCP support silently skips this one server instead of failing the
session, and a user-defined `sbx` entry in `.agents/mcp.json` overrides the
auto-registration entirely.

```json
{
  "mcpServers": {
    "github": {
      "url": "https://example.com/mcp",
      "headers": {
        "Authorization": "Bearer ${env:GITHUB_TOKEN}",
        "X-Client": "phi"
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

## Schema

The top-level object accepts only `mcpServers`. Server names contain letters,
numbers, `_`, or `-`; `phi` is reserved case-insensitively. Duplicate names in
the file fail the turn — JSON's last-key-wins merge is not treated as valid.

- Stdio servers set `command` and may set `args` and `env`. `command` may be a
  PATH name (`npx`, `uvx`, `python`), an absolute path, or a path relative to
  the workspace. Phi resolves PATH names to absolute paths before handing
  them to ACP.
- Remote servers set `url` and may set `headers`. Transport defaults to
  streamable HTTP. Set `"type": "sse"` when the endpoint is SSE.
- `"type": "stdio" | "http" | "sse"` is optional when `command` or `url` is
  present. `"disabled": true` skips a server without deleting it.
- Do not set `command` and `url` on the same server. `envFile` and OAuth
  `auth` blocks are not supported.

`command`, `args`, `env`, `url`, and `headers` interpolate:

- `${env:NAME}` or `${NAME}` — process environment
- `${userHome}`, `${workspaceFolder}`, `${workspaceFolderBasename}`
- `${pathSeparator}` and `${/}`

Keep secrets out of the file: reference environment variables instead of
pasting tokens. Phi resolves interpolations from its own process environment
and never persists the resolved values. Errors name missing variables and do
not print other environment values. Header values that interpolate must use
`https://` (or `http://` on localhost) so secrets are not forwarded in
cleartext.

Phi validates remote transports against the selected harness's advertised ACP
capabilities. ACP requires all harnesses to support stdio. Invalid files,
missing environment variables, unsupported transports, and duplicate or
reserved names fail the agent turn with an actionable system error.

Phi reads the file before each turn and stores a hash of the resolved server
list on the thread-session binding. If that hash changes — live, or after a
process restart — the ACP session is closed and replaced rather than resumed.
A new session that includes stdio servers posts their resolved command paths
in the thread.

## Trust

Treat `.agents/mcp.json` as executable workspace configuration. A stdio entry
starts the named executable, and a remote entry can receive configured headers
and expose tools with external side effects. Review changes to this file before
running agents in an untrusted workspace. Until an approval UI exists, Phi
posts resolved stdio command paths in the thread when those servers start.
