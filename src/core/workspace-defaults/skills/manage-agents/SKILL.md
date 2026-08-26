---
name: manage-agents
description: Create, update, or delete persistent Phi agent definitions, or select validated harness settings for anonymous agent dispatches.
---

# Manage Phi agents

Persistent agent definitions live at `.agents/agents/<name>.md`. Before creating
or changing one, call `list_agent_harnesses` for the intended harness. Copy its
harness ID, model ID, config option IDs, and config values verbatim; never guess
or rewrite an advertised value.

Use lowercase kebab-case filenames. An agent file contains YAML frontmatter and
an instruction body:

```markdown
---
description: Reviews implementation work
harness: codex
model: exact-model-id-from-list_agent_harnesses
config:
  effort: high
---

Review the implementation and report concrete findings.
```

- `harness` is required.
- `description`, `model`, and `config` are optional. Omit `model` or a config
  key to use the harness default.
- Only `.agents/agents/default.md` may declare `role: default`. Preserve that
  role when updating the default agent.
- Put persona and operating instructions in the Markdown body, not in
  frontmatter.

Read an existing definition before updating or deleting it. Preserve fields
the user did not ask to change. Do not delete or replace the default agent
unless the user explicitly requests it; Phi needs a valid default agent for
unaddressed messages.

For an anonymous dispatch, do not create an agent file. Call
`list_agent_harnesses`, choose an available harness, and pass the returned
model and config values unchanged to the dispatch tool.
