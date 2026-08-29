# Internal Phi Tools over MCP

Status: Draft (design decisions, not yet implemented)
Depends on: [channels-and-server.md](./channels-and-server.md) §5, §9

Agents run over ACP with no knowledge of phi beyond the prompt text they are
handed, and phi does not display agent traces — the streamed ACP output is
internal. The agent's only channel to the user is an internal phi tool:
`send_message`. This document records how phi exposes its internals to
agents as MCP tools — an in-process HTTP MCP server mounted on the existing
`Bun.serve` listener, announced to each agent session through ACP's native
`mcpServers` field, authenticated with per-session bearer tokens — and the
messaging contract that shapes how agents use them.

## 1. Summary of decisions

| Topic | Decision |
| ----- | -------- |
| Transport | Streamable HTTP, stateless, mounted at `/mcp` on the existing server |
| Hosting | In-process — tools call the live `PhiStore` directly, no subprocess |
| Announcement | `mcpServers: [{ type: "http", ... }]` in `session/new`, `session/resume`, or `session/load` |
| Identity | Per-session bearer token minted in `ensureSession`, mapped to `{ threadId, agentName }` |
| Token lifetime | Exactly one live logical ACP session attachment; rotated on resume and gone on restart |
| First tool | `send_message` — the agent's only voice; each call is one chat bubble |
| Agent traces | Not displayed; `agent_message_chunk` text is kept only as a silent-turn fallback |
| Messaging contract | Reply first, work out loud, ack ≠ delivery, close the loop (§6) |
| Working indicator | Explicit per-thread turn state, persisted; replaces last-author inference (§6.1) |
| Message shape | Short multi-bubble runs, prose over outlines; enforced by prompt, not schema |
| Workspace tools | `create_channel` with external folder roots; read tools follow after `send_message` |
| Stdio fallback | Deferred until a harness without HTTP MCP support needs it |
| SDK | `@modelcontextprotocol/sdk` (new dependency) |

## 2. Why in-process HTTP

ACP's `McpServer` union supports `stdio`, `http`, and an experimental `acp`
transport. The obvious-looking choice — a stdio MCP server the harness
spawns — is wrong for phi:

- A stdio server is a fresh subprocess per agent session with no access to
  the live `PhiStore`. Every tool call would loop back into the server over
  HTTP anyway, so stdio buys a process to manage and nothing else.
- The phi server is already an HTTP listener (`Bun.serve` in
  `src/server/serve.ts`). Mounting `/mcp` beside the existing
  `/api/v1/*` routes gives tools the same store instance the runtime and
  API share — same in-memory state, same broadcast path — with zero process
  management. For `send_message` this is not just convenient but load-
  bearing: the whole UX (§6) is built on live, mid-turn bubbles landing in
  the chat the moment the agent sends them, not after the turn ends.
- One endpoint serves every concurrent agent session; identity is carried
  by the request, not the process (§4).

The experimental `acp` transport (tools tunneled over the ACP channel
itself) would also avoid a listener, but it is explicitly unstable and not
implemented by the harnesses phi launches. Not worth building on yet.

## 3. Announcement and capability gating

`AgentRuntime.ensureSession` passes workspace servers from `.agents/mcp.json`
(see [workspace-mcp.md](./workspace-mcp.md)) followed by Phi's internal server
in `session/new`, `session/resume`, and `session/load`:

```ts
mcpServers: [
  ...workspaceServers,
  {
    type: "http",
    name: "phi",
    url: `http://localhost:${port}/mcp`,
    headers: [{ name: "Authorization", value: `Bearer ${token}` }],
  },
]
```

ACP obligates the harness (the MCP client) to attach these headers to every
request it makes to the server. The agent model never sees the token — it is
transport plumbing, not context — so it cannot leak it in a reply or be
prompt-injected into using another session's.

Harness support varies: the `initialize` response advertises
`mcpCapabilities` (http/sse) under `agentCapabilities`. Because
`send_message` is the only path to the user, a harness that cannot speak
HTTP MCP cannot run as a phi agent at all: the runtime fails the session
with a clear error rather than silently starting a mute agent. (The stdio
fallback shim in §8 lifts this restriction if it ever matters.) The
config-listing session in `src/core/agents/config.ts` keeps
`mcpServers: []` — it exists only to read config options and is killed
immediately.

`AgentRuntime` needs two new inputs for this: the server's port and the
token registry (§4). Both arrive through the constructor, following the
existing `resolveCommand` test-hook pattern.

## 4. Per-session tokens

The `/mcp` endpoint must not be an open localhost write path — with
`send_message` mounted, an unauthenticated endpoint would let any local
process post into any thread as the agent. Identity also cannot come from
tool arguments, because arguments are model-authored. Both problems have
one answer: a random bearer token per ACP session, resolved server-side to
the calling session.

Lifecycle:

1. **Mint** — `ensureSession` generates a token (`crypto.randomUUID()` is
   sufficient entropy for a process-lifetime secret) and registers it in an
   in-memory `McpTokenRegistry`: `Map<token, { threadId, agentName }>`.
2. **Deliver** — the token rides in the `headers` field of the announced
   server entry (§3).
3. **Validate** — every `/mcp` request does one registry lookup before any
   tool logic; missing or unknown tokens get 401. The resolved caller is
   passed into tool execution as ambient context: tools never take identity
   from arguments. `send_message` posts to the caller's thread by default;
   a `thread_id` argument is accepted only when it names that thread or,
   on a doc-comment turn, the recorded parent.
4. **Revoke** — `dropSession` removes the logical session's token. ACP host
   processes are pooled separately and may continue serving other sessions.
   The durable harness session binding remains, but a later resume receives a
   new token. A restart clears the registry, so stale
   tokens resolve to nothing — the desired behavior.

The registry is its own small class in the server layer, constructed by
`startServer` and handed to both the runtime (mint/revoke) and the `/mcp`
route (lookup). That split keeps it trivially fakeable in tests. The
registry entry also carries per-turn state the runtime needs (§5.2): a
count of `send_message` calls since the turn began.

What the token deliberately is not: a durable credential (session lifetime
is the expiry; nothing persists) or a defense against a hostile local
machine (localhost HTTP is plaintext; a process that can read another's
memory has already won). It is session identity plus a lock on the door.

Free by-product: every tool call arrives pre-attributed to
`{ threadId, agentName }`, so per-agent audit logging is one line when
wanted.

## 5. The MCP server and `send_message`

`src/server/mcp.ts` builds the server with `@modelcontextprotocol/sdk` and
registers tools directly over `PhiStore`.

One Bun-specific wrinkle: the SDK's `StreamableHTTPServerTransport` is
written against Node `req`/`res`. Rather than bridging (`fetch-to-node`),
phi runs the transport **stateless**: each POST to `/mcp` is an independent
JSON-RPC exchange handled in a plain fetch handler. Tool calls need nothing
more; there is no server-initiated traffic to keep a stream open for. If a
future tool needs progress notifications, revisit with the bridge.

### 5.1 `send_message`

The first tool, and the agent's only voice.

- **Arguments**: `content` (markdown string). No thread argument, no
  author argument — both come from the token. Deliberately minimal so the
  contract survives harness and model drift.
- **Effect**: `store.appendMessage(caller.threadId, { author:
  "coordinator", kind: "message", content, metadata: { agent:
  caller.agentName } })` — the same write path and broadcast the REST API
  uses. **One call is one chat bubble**, rendered live. This is what makes
  the multi-bubble texting shape in §6 possible: a two-beat reply is two
  quick `send_message` calls, not one welded paragraph.
- **Description**: the tool description is the primary prompting surface —
  it reaches the model verbatim on every turn — so it carries the core of
  the messaging contract (§6): this is your only voice, nothing outside it
  is ever shown to anyone; reply first; keep the user posted on meaningful
  beats; an acknowledgement never counts as delivering the result; send
  the final answer through this tool before ending the turn.

Because messages stream out mid-turn, turn serialization is unchanged:
`send_message` happens *within* the turn the runtime is already running,
and the per-thread `turns` chain still admits one turn at a time.

### 5.2 What happens to the ACP turn text

`runTurn` currently concatenates `agent_message_chunk` text into the
coordinator reply. That flips: chunk text is the agent's inner monologue —
a private scratchpad the user never sees. It is retained in-memory per
turn for the fallback below and (later) for debugging.

After `session/prompt` resolves, the runtime asks the registry how many
`send_message` calls the turn made:

- **≥ 1** — the turn communicated; nothing more to append. The final turn
  text is discarded.
- **0 and the turn produced final text** — fallback: append that text as
  the coordinator message, flagged in metadata
  (`{ via: "turn-text-fallback" }`). A model that ignored the tool still
  reaches the user; the metadata makes the misbehavior observable so
  prompting can be fixed rather than silently papered over.
- **0 and no text** — the existing "ended the turn without a reply"
  system error, unchanged.

The target UX is strict (plain output is never delivered — the model must
own its voice), and the fallback dilutes that on purpose: a silent thread
is worse than an unlabeled reply path. It is a training-wheels mechanism,
tracked via its metadata flag, removed once harness prompting proves
reliable.

### 5.3 Read tools

Following `send_message`, the read slice:

| Tool | Backing store call | Notes |
| ---- | ------------------ | ----- |
| `list_channels` | `listChannels(workspaceId)` | workspace resolved server-side |
| `list_threads` | resolve channel name, then `listThreads(channelId)` | agents pass a channel name, never its ID |
| `read_thread` | `listMessages(threadId)` | current thread, or the comment's parent |
| `search_messages` | hybrid FTS5 + local embeddings | workspace/current thread resolved server-side; optional channel name, author, and current-thread opt-in; never channel/thread IDs |

Cross-thread reads via `read_thread` are limited to the caller's thread and
a doc comment's recorded parent — enough to pull the sharing conversation
without a general thread browser. `send_message` may post to that same
parent (`thread_id`); arbitrary thread ids are rejected.

`search_messages` is the first read tool implemented. It excludes the caller's
current thread by default; `includeCurrentThread: true` opts it back in without
exposing thread IDs. `author` can narrow results to `user` or `agent` messages.
It chunks message text, indexes exact terms synchronously with FTS5, and tries a
quoted phrase followed by an AND of meaningful quoted terms. Local MiniLM
embeddings provide paraphrase recall asynchronously in a dedicated worker.
Embeddings are durable `Float32Array` BLOBs in SQLite. The worker loads each hot
workspace into one contiguous vector slab using keyset-paginated batches and
scans it exactly. Results collapse to the best message per thread;
`threadHitCount` is the total distinct matching messages represented in the
candidate pool for that thread. `matchedBy` reports keyword and/or semantic
matching; internal rank scores are not exposed. If local model inference is
unavailable, the tool degrades to lexical results and reports
`semanticAvailable: false`.

### 5.4 `create_channel` and attached folders

`create_channel` derives the workspace from the caller token and accepts a
lowercase channel name, an optional purpose, and zero or more existing absolute
folder paths. Paths are resolved through symlinks, must be directories outside
phi's managed workspace, and are deduplicated before being persisted on the
channel.

The workspace root remains the session `cwd`. Harnesses advertising ACP
`sessionCapabilities.additionalDirectories` receive the channel folders on
`session/new`, `session/resume`, and `session/load`. Cursor currently exposes
the equivalent as repeatable process-level `--add-dir` flags, so Cursor ACP
hosts are pooled by folder set rather than globally.

Logical sessions remain keyed by `(thread, agent)`, but ACP processes are host
pools: normally one process per harness, with many isolated session IDs.
Inactive logical sessions are closed after ten minutes and empty hosts after a
further thirty seconds; durable bindings let later turns resume normally.

## 6. The messaging contract

The UX phi is aiming for is a live chat with a competent teammate, not a
progress bar or a report generator. (Reference point: Cursor's Grok Bot
system prompt, whose "SendMessage is your only voice" model this design
matches.) The contract has four beats, delivered to the agent through the
`send_message` description and a standing prompt preamble:

1. **Reply first.** The first action on any user turn is a `send_message`
   — a direct answer if it's quick, or a short acknowledgement naming the
   first concrete step if it's real work — *before* any other tool call.
   An agent that dives straight into silent tool calls looks frozen from
   the user's side.
2. **Work out loud.** On multi-step work, send a short update at each
   meaningful beat: a step finished, a real finding, a decision, a
   blocker, a change of plan. Meaningful means decision-relevant — fold
   routine mechanics, retries, and self-correcting hiccups into the next
   real update rather than narrating them. The failure modes are
   symmetric: a long silent stretch reads as a frozen app; a wall of
   play-by-play bubbles is noise. When in doubt, err toward a quick
   update over silence.
3. **Ack ≠ delivery.** The opening acknowledgement never discharges the
   result. Whatever the user is actually waiting on — the answer, the
   output, the outcome — goes through `send_message` before the turn
   ends. Anything typed outside the tool was never delivered.
4. **Close the loop.** End real work with a short recap of what was done.

Shape guidance rides along with the cadence rules: text like a person,
not a memo — most updates are a sentence or two; multi-beat replies go
out as a short run of separate `send_message` bubbles rather than one
welded paragraph; prose over bold-headed outlines; lead with the result,
not a status word. None of this is enforced by schema — it is prompt
material — but the one-call-one-bubble rendering (§5.1) is what makes the
shape achievable at all.

Where the contract lives, in order of authority: the `send_message` tool
description (always in context, survives long turns), then a short
standing preamble prepended to `session/prompt` reinforcing reply-first
and cadence. Once workspace instruction files land
([channels-and-server.md](./channels-and-server.md) §6), the preamble
migrates there. The turn-text fallback (§5.2) is the contract's safety
net, and its metadata flag is the measure of how well the prompting is
working.

### 6.1 The working indicator needs explicit turn state

Clients currently infer the working shimmer from "latest message is from
the user." Reply-first breaks that inference deterministically on every
turn: the ack lands within seconds, the latest message becomes the
coordinator's, and the thread looks finished while the real work is just
starting. So explicit per-thread turn state ships in the same slice as
`send_message` — it is not a follow-up polish item.

Mid-turn bubbles also change what the indicator *means*: no longer "a
reply is coming" but "the agent is still active in this thread." The
rendering that matches is a Slack-style presence line — "{agent} is
working…" pinned below the latest message for as long as the turn is in
flight — coexisting with bubbles arriving above it, not a message-shaped
placeholder that each bubble replaces.

Mechanics:

- The runtime counts queued-plus-running turns per thread: the flag flips
  on synchronously when a user message is committed (so the `thread.turn`
  frame can never trail the send's HTTP round-trip) and off only when the
  count returns to zero (so chained turns read as one continuous working
  state, not an off/on blink between them). The server broadcasts
  `thread.turn` frames (`{ threadId, active, agent }`) through the same
  hub as message frames. This is turn activity, not thread lifecycle —
  `open/settled/archived` is untouched.
- The marker is **persisted** on the thread row (set/cleared at the same
  two points the broadcast fires), because the same broken author
  inference lives server-side: `recoverInterruptedTurns` detects dropped
  turns by "last message is from the user," and once acks exist a server
  dying mid-turn after the ack leaves the coordinator as the last author
  — recovery would miss the thread and it would hang silently forever.
  Recovery becomes "threads whose turn flag is still set at startup":
  strictly more accurate than the heuristic it replaces.
- Reconnecting clients receive the active-turn set with their snapshot,
  since they may have missed the `active: true` frame.

## 7. File links

Messages can reference workspace files, and the app renders them viewable in
place. The contract is convention, not tooling:

- **A relative markdown link or image embed in a message refers to a
  workspace file** — `[the report](channels/general/report.md)`,
  `![chart](analysis/chart.png)`. One preamble sentence teaches it; there is
  no `attach_file` tool and no schema change, and in a client that does not
  understand the convention the link is still legible text.
- The server serves files read-only (`src/server/files.ts`):
  `GET /api/v1/files/<path>` is the managed workspace; a channel also
  exposes its attached folders as named roots (`workspace` plus each
  folder's basename). `GET /api/v1/channels/:id/files/<path>` searches
  those roots and 302s to the canonical
  `/api/v1/channels/:id/file-roots/:root/<path>` when the match is unique
  (409 if two roots contain the same relative path). Containment is
  checked per root after symlink resolution, so neither `..` traversal
  nor a symlink can leave the chosen tree. Responses are content-typed by
  extension, `no-store` cached, and size-capped.
- The web client maps relative hrefs onto the channel-scoped endpoint
  when the message has a channel: images render inline in the bubble;
  other files render as a chip that opens a viewer dialog (markdown
  rendered, code/text as-is, PDFs framed, HTML rendered statically in an
  iframe — scripts never run, enforced by a `script-src 'none'` /
  `connect-src 'none'` CSP on the response; an iframe sandbox is
  deliberately not used because its opaque origin trips Chrome's
  private-network-access blocking on localhost-served apps — everything
  else a download).   Href segments are decoded once before encoding, so
  `My%20Report.md` stays a space and `report.md#summary` keeps `#summary`
  as a fragment. Markdown opened in the viewer assigns GitHub-style
  heading ids and scrolls to the matching target. Relative links inside
  that file resolve from its directory, staying on the same root. Verbatim
  user messages get the same treatment for workspace-looking paths, so
  users can link files back at agents.
- Links are **live references, not snapshots**: the viewer shows the current
  bytes and reports a file that has since been deleted. Pinning a link to
  the checkpoint observed at message time (`git show <sha>:<path>`, sha
  recorded in message metadata) is deferred; it composes with this design
  without changing the contract.

### 7.1 User uploads

Client paths are never server workspace paths. Browser (and later native)
clients upload bytes over HTTP; the server stores them under
`$PHI_ROOT/uploads/<id>` — outside the managed workspace and attached
repositories, so they are not git-checkpointed and cannot be confused with
`Read`able workspace files.

- `POST /api/v1/attachments` accepts `multipart/form-data` field `file`
  (browsers) or a raw body with `Content-Type` plus `X-Phi-Filename` /
  `Content-Disposition` (native `URLSession`). IDs are server-generated
  (`att_` + 32 hex). Original filename is sanitized (basename only; no
  traversal) and stored as metadata with the declared/detected content type
  and byte size. `PHI_UPLOAD_MAX_BYTES` caps size (default 25 MiB);
  the body is streamed and aborted when the cap is exceeded. Multipart is
  written to a bounded temp file before parsing, so a chunked request
  without `Content-Length` cannot grow without limit.
- Upload, metadata, and preview/download require a device bearer:
  `Authorization: Bearer` (native) or the HttpOnly `phi-device` cookie
  (browser). Loopback `GET /api/v1/auth/session` sets that cookie and
  never returns the token in JSON. The secret is `$PHI_ROOT/device-token`
  (`0600`); `PHI_API_TOKEN` is an optional extra accepted value. MCP
  session tokens are not valid here.
- `GET /api/v1/attachments/:id` returns the bytes.
  `GET /api/v1/attachments/:id/meta` returns JSON.
  HTML responses reuse the file-viewer CSP (`script-src 'none'`). Bytes are
  never sent on `/ws` — frames carry the message row, whose
  `metadata.attachments` lists `{ id, filename, contentType, byteSize }`.
- Messages reference uploads with `attachment:att_…` in markdown (agents)
  or `metadata.attachments` (the composer). The web UI renders images
  inline and other files as the existing chip/viewer, pointed at the
  attachments API — not `/api/v1/files/*`.
- When a harness advertises ACP `promptCapabilities.image`, image
  attachments under 4 MiB are embedded as prompt image blocks. Other files
  are listed in the prompt text. Harnesses can read bounded UTF-8 text
  attachments with the thread-scoped MCP `read_attachment` tool; binary
  attachments remain available only through the device-authenticated HTTP
  route.

Rejected for this slice: writing uploads into the workspace; treating a
client filesystem path as a server path; putting bytes on `/ws`; resumable
chunked uploads; native pickers / Quick Look / Share extensions.

Rejected: an `attach_file` tool / `attachments` parameter (a tool-use
behavior the model must remember, for marginal gain over links — additive
later if rich cards are wanted); serving absolute filesystem paths (clients
must work remote/mobile, and absolute paths leak host layout — the preamble
tells agents to use workspace-relative paths).

### 7.2 Doc comments

Comment threads on shared markdown are ordinary threads with
`threads.kind = 'doc_comment'` and a `doc_comment_anchors` row, including
an optional `parent_thread_id` pointing at the chat thread the doc was
opened from. They stay out of `list_threads` / channel flow / Activity.
There is no agent-facing comment tool — the user creates comments; agents
reply through `send_message`.

Routing matches chat: a leading `@name` is the addressee; otherwise the
last agent that answered in this comment thread, else the agent the root
routed to. A new unmentioned comment inherits the parent thread's agent
as that root, else the workspace default. Mid-body mentions are
speculative. Retry on an unmentioned comment wakes that fallback agent.

The comment-thread prompt includes the quoted excerpt, surrounding source,
and (when known) the parent thread id. `read_thread` pulls that parent's
messages. `send_message` may pass `thread_id` set to the parent to post a
resolution into the sharing conversation; other thread ids are rejected.

HTTP (device-auth, same as the rest of the app API):

- `GET /api/v1/channels/:id/doc-comments?root=&path=`
- `POST /api/v1/channels/:id/doc-comments`
- `GET /api/v1/channels/:id/doc-comments/summary` (`parentThreadId` optional)

`GET /api/v1/threads/:id` includes `anchor` when the thread is a doc
comment, so clients can canonicalize `/t/:id` and wrong-channel doc URLs
to `/c/:channelId/doc/:id`.

## 8. Rejected alternatives

- **Displaying the ACP turn text as the reply (status quo)** — couples
  what the user sees to harness streaming behavior, renders commentary and
  answer as one undifferentiated blob, and gives the agent no way to post
  an update *between* tool calls; the user watches silence until the turn
  ends. It also forecloses the entire §6 UX: no reply-first, no mid-turn
  beats, no multi-bubble shape.
- **Stdio MCP subprocess** — no live-store access; loops back over HTTP
  anyway (§2). Kept as a *fallback shim* design (a thin
  `bun src/server/mcp-stdio.ts --token …` proxy to the HTTP endpoint) for
  harnesses without HTTP MCP support, built only when one needs it — until
  then such harnesses simply cannot run as phi agents (§3).
- **Unauthenticated localhost endpoint** — every local process could post
  into any thread as the agent; identity would have to come from
  model-authored arguments.
- **Token in tool arguments or prompt text** — visible to the model,
  leakable, injectable. Headers keep it out of context entirely.
- **Reusing the pairing-token auth planned for clients**
  ([channels-and-server.md](./channels-and-server.md) §9) — client tokens
  are per-device and durable; agent tokens are per-session and disposable.
  Different lifetimes, different registries. They can share header-parsing
  helpers later.
- **Exposing the `/api/v1` REST routes to agents directly** — agents speak
  MCP natively through their harnesses; REST would need bespoke prompt
  documentation and still lack per-session identity.
- **Enforcing message shape in the tool schema** (max length, required
  `kind`, structured beats) — the shape rules in §6 are register, not
  structure; schema constraints would fight models that phrase things
  differently without buying correctness. Markdown string in, bubble out.

## 9. Implementation sequence

1. `McpTokenRegistry` (server layer): mint/lookup/revoke plus per-turn
   send counting, with tests.
2. `src/server/mcp.ts`: stateless streamable-HTTP handler + `send_message`
   over `PhiStore`; mounted at `/mcp` in `serve.ts`. Tests exercise the
   route with a real store and fake registry: 401 on missing/unknown
   token, message lands in the caller's thread with agent metadata, two
   calls produce two message rows.
3. Runtime wiring: port + registry into `AgentRuntime`; mint in
   `ensureSession`, announce in `session/new` (failing the session when
   the harness lacks HTTP MCP support), revoke in `dropSession`; `runTurn`
   switches to the §5.2 policy (tool-sent messages primary, turn-text
   fallback flagged in metadata, silent-turn error retained) and drives
   the §6.1 turn state (persisted flag + `thread.turn` broadcast;
   `recoverInterruptedTurns` switches from last-author inference to the
   flag; the web client renders the presence line from the frames and
   the snapshot's active-turn set). Runtime tests cover all three turn
   outcomes, the announced entry's token round-tripping through the
   registry, and turn-flag set/clear/recovery.
4. Messaging contract prompting (§6): the `send_message` description and
   the `session/prompt` preamble. Iterate against real harnesses using
   the `turn-text-fallback` metadata rate as the signal.
5. Read tools (§5.3).
6. Later, on demand: the stdio fallback shim, audit logging, richer
   message kinds (progress vs result) if clients want to render them
   differently.
