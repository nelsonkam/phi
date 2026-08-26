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
| Token lifetime | Exactly one live ACP process attachment; rotated on resume and gone on restart |
| First tool | `send_message` — the agent's only voice; each call is one chat bubble |
| Agent traces | Not displayed; `agent_message_chunk` text is kept only as a silent-turn fallback |
| Messaging contract | Reply first, work out loud, ack ≠ delivery, close the loop (§6) |
| Working indicator | Explicit per-thread turn state, persisted; replaces last-author inference (§6.1) |
| Message shape | Short multi-bubble runs, prose over outlines; enforced by prompt, not schema |
| Read tools | `list_channels`, `list_threads`, `read_thread` follow after `send_message` |
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

`AgentRuntime.ensureSession` passes the following in `session/new` and again
with a freshly minted token in `session/resume` or `session/load`:

```ts
mcpServers: [{
  type: "http",
  name: "phi",
  url: `http://localhost:${port}/mcp`,
  headers: [{ name: "Authorization", value: `Bearer ${token}` }],
}]
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
   from arguments. `send_message` posts to the caller's own thread by
   construction — there is nothing the model can put in the arguments to
   post elsewhere.
4. **Revoke** — `dropSession` removes the thread's token alongside killing
   the process. The durable harness session binding remains, but a later
   resume receives a new token. A restart clears the registry, so stale
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
| `read_thread` | `listMessages(threadId)` | defaults to the caller's own thread |
| `search_messages` | hybrid FTS5 + local embeddings | workspace resolved server-side; optional channel name, never channel/thread IDs |

Cross-thread reads are allowed — threads are not secret from each other —
but the caller's identity always comes from the token, never from
arguments. Cross-thread *writes* (a `threadId` argument on `send_message`)
remain out: one thread, one conversation, one voice.

`search_messages` is the first read tool implemented. It chunks message text,
indexes exact terms synchronously with FTS5, and generates normalized local
MiniLM embeddings asynchronously in a dedicated worker. Embeddings are durable
`Float32Array` BLOBs in SQLite. The worker loads each hot workspace into one
contiguous vector slab using keyset-paginated batches, scans it exactly, and
combines semantic and lexical ranks with reciprocal-rank fusion. If local model
inference is unavailable, the tool degrades to lexical results and reports that
semantic search was unavailable.

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

## 7. Rejected alternatives

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

## 8. Implementation sequence

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
