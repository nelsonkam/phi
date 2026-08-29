# Phi in Docker Sandboxes

Phi's sandbox is a persistent computer, not a wrapper around a host repository.
It is created without a host workspace mount and runs the Phi web server plus
Claude Code, Codex, and Cursor inside Docker Sandboxes' microVM boundary.

## Requirements

- Docker Sandboxes `sbx` v0.42.0-rc1 or newer. Phi requires the no-workspace
  create flow and rejects older releases that predate the relevant isolation,
  OAuth callback, and egress fixes.
- A Phi release with matching OCI kit and multi-architecture image tags.

The official Phi kit declares proxy-managed subscription OAuth only.
Authentication belongs to sbx: real OAuth tokens stay in its host-side
credential store and Phi sees only non-secret proxy sentinels. Keeping API-key
declarations out of the kit prevents an absent credential from becoming a
placeholder that a CLI mistakes for a real key.

For a ChatGPT subscription, complete OpenAI OAuth on the host before creation:

```bash
sbx secret set openai --oauth
phi sandbox create --name phi
```

Claude and Cursor complete their subscription logins from their own CLIs. Do
not configure an API key for a provider whose subscription you want to use,
create the sandbox, then run:

```bash
sbx exec -it phi claude
# Run /login in Claude, then exit.

sbx exec -it phi cursor-agent
# Complete Cursor's login, then exit.

# Refresh the sandbox credential-mode environment after first-time login.
phi sandbox stop phi
phi sandbox start phi
```

Startup reruns Phi's OAuth-aware Claude and Codex configuration. This depends
on sbx recomputing `SBX_CRED_*_MODE` when a sandbox starts after a new OAuth
binding; confirming that behavior on v0.42.0-rc1+ is a release validation gate.

The root kit declares the complete OAuth interception contracts directly. It
writes Claude's sentinel credential file, points Codex at the ChatGPT Codex
backend with a sentinel bearer token, and gives Cursor its OAuth sentinel
statically while keeping credentials in memory and forcing traffic through the
proxy-compatible HTTP/1 path. No custom CA certificate is required; the CA used
in the original Cursor proof was only for corporate WARP TLS inspection.

### API keys through custom secrets

API-key users can create sandbox-scoped custom secrets after creation. The real
value remains in sbx's host store; the VM receives an `sbx-cs-…` placeholder,
and the egress proxy substitutes the real value only for the listed hosts.
With the corresponding key already exported in the host shell, use only the
providers you need:

```bash
sbx secret set-custom --sandbox phi \
  --env ANTHROPIC_API_KEY \
  --host api.anthropic.com --host '*.anthropic.com' \
  --value "$ANTHROPIC_API_KEY"

sbx secret set-custom --sandbox phi \
  --env OPENAI_API_KEY \
  --host api.openai.com --host '*.openai.com' \
  --value "$OPENAI_API_KEY"

sbx secret set-custom --sandbox phi \
  --env CURSOR_API_KEY \
  --host api2.cursor.sh --host '*.cursor.sh' \
  --host api.cursor.com --host cursor.com --host '*.cursor.com' \
  --value "$CURSOR_API_KEY"

phi sandbox stop phi
phi sandbox start phi
```

`set-custom` also accepts `--ref` and `--command` so a secret manager can
provide the value without putting it directly on the command line. Do not keep
an OpenAI OAuth binding when using an OpenAI API key: OAuth mode configures
Codex for the ChatGPT backend instead of the normal API provider. Remove the
global binding with `sbx secret rm openai` before restarting the sandbox.

## Sandbox MCP gateway

When sandboxd reserves an MCP gateway for the sandbox, it injects
`MCP_GATEWAY_URL` and `MCP_SENTINEL_TOKEN_NAME` into the environment. Phi
auto-registers that gateway as an HTTP MCP server named `sbx` for every agent
session, sending the sentinel name as the bearer token so the host proxy can
substitute the real token per request — the same wiring Docker's built-in
agent kits use. Harnesses without HTTP MCP support skip the gateway rather
than failing, and a user-defined `sbx` server in `.agents/mcp.json` overrides
the auto-registration. See [workspace-mcp.md](workspace-mcp.md).

## Lifecycle

```bash
phi sandbox create [--name phi] [--kit <mixin-ref>]...
phi sandbox status [phi]
phi sandbox open [phi]
phi sandbox stop [phi]
phi sandbox start [phi]
phi sandbox remove phi --confirm
```

The launcher selects the root kit and official Claude, Codex, and Cursor
mixins tagged with the running Phi version. Custom mixins compose last. Phi
always prints the complete plan and requires confirmation for custom setup. If
the installed sbx exposes machine-readable kit inspection, Phi also reports
detectable overlapping fields; otherwise it warns and continues. `sbx` remains
the source of truth for lifecycle, kit governance, signatures, credential
bindings, and network policy; Phi keeps no sandbox registry of its own.

The root kit owns the three credential contracts because direct root OAuth
declarations are the verified schema-v2 path. The Claude, Codex, and Cursor
mixins provide their narrowly scoped network policies.

Removal is destructive. Push important repository branches and back up Phi
state before using it.

## Filesystem

```text
/home/agent/.phi/
├── phi.db
├── models/
└── workspace/                 Phi-managed cwd and checkpoint tree
    ├── .agents/
    └── channels/<name>/
        └── AGENTS.md          channel context and repository pointers

/home/agent/work/
├── repos/                     ordinary clones
└── worktrees/                 ordinary Git worktrees
```

Phi owns the managed workspace's Git history. Agents must not run Git there.
Normal project Git and build work happens under `/home/agent/work`, outside
Phi checkpoints. Every channel has a starter `AGENTS.md`; record the relevant
repository and worktree paths there and point to each repository's own
instruction file. Phi repairs missing channel folders at startup and after a
checkpoint restore without overwriting existing context.

The VM and work volume persist across stop/start but are deleted by `sbx rm`.
The file browser remains rooted at the managed workspace, so agents should put
linkable reports and summaries in the channel folder. Docker commands inside
the sandbox reach its isolated Docker Engine, never the host daemon.

## Image variants and validation

`PHI_HARNESSES` is a comma-separated image build argument. It accepts only
`claude-code`, `codex`, and `cursor`, defaults to all three, and is baked into
`/etc/phi/harnesses` plus the runtime environment. Phi advertises only those
harnesses. Their versions are explicit Docker build arguments and no CLI is
downloaded at container startup.

Validate the schema-v2 kits with:

```bash
bun run validate:sandbox-kits
```

The release workflow builds Linux x64 and arm64 standalones, probes the native
ONNX binding, performs an ACP initialize/shutdown handshake for every supported
harness, publishes SHA-256 checksum assets, verifies the matching checksum while
building each image architecture, and signs the image and kit digests.
