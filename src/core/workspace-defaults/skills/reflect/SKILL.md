---
name: reflect
description: Distill recent channel history into shared memory and propose procedure changes. Run when asked, or when the nightly job tells you to.
---

# Reflect

Turn new conversation into durable workspace knowledge. Any agent can run this
at any time; a scheduled job also runs it once a day at 3am.

## Checkpoints

`get_reflection_checkpoint` / `set_reflection_checkpoint` store the last
message sequence fully processed per channel. Use them so you don't re-distill
the same messages. `through_seq` 0 means the channel has never been processed.
Writes only move the cursor forward; a lower value is ignored so a slower pass
cannot rewind a newer one.

## Procedure

1. Read `.agents/memories/MEMORY.md` and the relevant fact files first.
2. Call `get_reflection_checkpoint` with no channel to list every channel.
   Skip `#reflection`.
3. For each remaining channel, survey with `list_channel_threads`. If the
   checkpoint is greater than 0, pass `from_seq` as `through_seq + 1`. If
   there are no new threads, skip the channel and leave the checkpoint
   unchanged.
4. `read_thread` anything that looks like a durable fact, decision,
   correction, preference, outcome, or repeated failure. Do not infer from
   previews alone.
5. Fact lane — apply only durable, explicit facts, decisions, corrections,
   and user-stated preferences. Update or supersede the canonical one-fact
   Markdown file instead of adding a duplicate, keep MEMORY.md indexed, and
   remove stale index entries. Delete an agent-authored fact file only when a
   replacement fully subsumes it and preserves its provenance; never delete
   or rewrite user-authored memory. Mark uncertain conflicts for review
   instead of silently choosing. Put workspace-wide user rules/preferences in
   `rules.md` and channel-specific ones in `channels/<name>/rules.md`. Use
   `schema_version` 1 and record `type`, `scope`, `learned_at`, and source
   thread. Never edit `AGENTS.md`.
6. Instruction lane — do not directly change skills or inferred procedural
   rules. When repeated failures, user corrections, or outcome tags justify a
   procedure change, open a review thread with `create_thread`. Route
   channel-scoped proposals to that channel and target
   `channels/<name>/skills/` or `rules.md`. Route workspace-global proposals
   to `#meta` and target `.agents/skills/`; if `#meta` does not exist, file
   the proposal in the current thread and label it workspace-global. Propose
   small delta edits with provenance and verification criteria, never a full
   rewrite.
7. After finishing a channel, `set_reflection_checkpoint` to the latest
   sequence you actually covered. If you stop early on a large backlog, still
   checkpoint that far so the next pass continues. Do not advance a channel
   you did not finish surveying.
8. Reply with a short recap: channels inspected, facts changed or cleaned up,
   and links to any review threads.

Preserve user-authored wording. Make no change when the evidence is weak. A
quiet pass with nothing to write is a valid outcome.
