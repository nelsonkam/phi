# Phi in Docker Sandboxes

Phi's sandbox is a persistent computer, not a wrapper around a host repository.
It is created without a host workspace mount and runs the Phi web server plus
Claude Code, Codex, and Cursor inside Docker Sandboxes' microVM boundary.

## Requirements

- Docker Sandboxes `sbx` v0.42.0-rc1 or newer. Phi requires the no-workspace
  create flow and rejects older releases that predate the relevant isolation,
  OAuth callback, and egress fixes.
- A Phi release with matching OCI kit and multi-architecture image tags.

The official Phi kit declares proxy-managed subscription OAuth for Claude and
Codex. Authentication belongs to sbx: real OAuth tokens stay in its host-side
credential store and Phi sees only non-secret proxy sentinels. Cursor uses a
host-side API key through an sbx custom secret; subscription OAuth is not
supported for Cursor in a custom Phi root.

For a ChatGPT subscription, complete OpenAI OAuth on the host before creation:

```bash
sbx secret set openai --oauth
phi sandbox create --name phi --port 43141
```

Claude completes its subscription login from its own CLI. Do not configure an
Anthropic API key when using a subscription; create the sandbox, then run:

```bash
sbx exec -it phi claude
# Run /login in Claude, then exit.
```

Startup configures Claude's proxy helper and Codex's ChatGPT backend with
sentinel credentials. Direct root-kit OAuth interception works even though sbx
reports provider credential modes as `none` for a custom sandbox, so Phi does
not use the `SBX_CRED_*_MODE` flags. If an `ANTHROPIC_API_KEY` or
`OPENAI_API_KEY` custom secret is present, startup instead leaves that CLI on
its normal API-key path.

The root kit declares the supported OAuth interception contracts directly. It
writes Claude's sentinel credential file and points Codex at the ChatGPT Codex
backend with a sentinel bearer token. No custom CA certificate is required;
the CA used in the original Cursor experiment was only for corporate WARP TLS
inspection.

### API keys through custom secrets

Cursor requires a sandbox-scoped custom-secret API key. Claude and Codex API-key
users can use the same mechanism. The real value remains in sbx's host store;
the VM receives an `sbx-cs-…` placeholder, and the egress proxy substitutes the
real value only for the listed hosts. With the corresponding key already
exported in the host shell, use only the providers you need:

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
provide the value without putting it directly on the command line. The
injected `OPENAI_API_KEY` placeholder automatically selects Codex's normal API
provider instead of the ChatGPT subscription backend.

Cursor subscription login is intentionally unsupported until Docker extends
OAuth interception to custom sandbox roots. Docker's built-in Cursor agent can
capture and refresh host-side OAuth, but the same declaration in Phi cannot
consume that credential. Persisting `cursor-agent login` inside the VM would
put real subscription tokens across the security boundary, so Phi keeps
`AGENT_CLI_CREDENTIAL_STORE=memory` and does not offer that fallback. The
seeded HTTP/1 setting remains required so custom-secret placeholder traffic
passes through the host proxy.

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
phi sandbox create [--name phi] [--port 43141] [--kit <mixin-ref>]...
phi sandbox status [phi]
phi sandbox open [phi]
phi sandbox stop [phi]
phi sandbox start [phi]
phi sandbox remove phi --confirm
```

Local sandboxd stops a runtime 30 seconds after its last attached session
disconnects, even when it was started with `sbx run --detached`. Phi therefore
keeps a detached host-side `sbx exec` session as a service lease. `create`,
`start`, and `open` establish that lease and wait for the published web port;
`stop` or `remove` ends it with the VM.

Pass `--port` at creation to keep the host-side URL stable. Phi passes an
explicit loopback-only mapping to sbx, for example
`127.0.0.1:43141:3141/tcp4`; the sandbox still listens on port 3141 internally.
The mapping persists across stop/start but is deleted with the sandbox. Without
`--port`, sbx allocates an ephemeral host port and `phi sandbox open` discovers
whatever port is currently published.

The launcher selects the root kit and official Claude, Codex, and Cursor
mixins tagged with the running Phi version. Custom mixins compose last. Phi
always prints the complete plan and requires confirmation for custom setup. If
the installed sbx exposes machine-readable kit inspection, Phi also reports
detectable overlapping fields; otherwise it warns and continues. `sbx` remains
the source of truth for lifecycle, kit governance, signatures, credential
bindings, and network policy; Phi keeps no sandbox registry of its own.

The root kit owns the verified Claude and Codex OAuth contracts plus Cursor's
proxy-compatible CLI settings. Cursor credentials come from a sandbox-scoped
custom secret. The Claude, Codex, and Cursor mixins provide their narrowly
scoped network policies.

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
