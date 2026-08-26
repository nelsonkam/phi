---
name: manage-channels
description: Create Phi channels and attach external working folders when the user wants a new channel or separate workspace context.
---

# Manage Phi channels

Create channels with Phi's `create_channel` tool. Do not edit Phi's database or
represent a channel by creating a directory manually.

- Use a short lowercase kebab-case name.
- Include a concise purpose when it will help agents understand the channel's
  scope.
- Attach only folders the user named or clearly placed in scope. Folder paths
  must be absolute, must already exist, and must be outside Phi's managed
  workspace.
- A channel may attach multiple folders. Phi keeps its managed workspace as the
  session working directory and passes the attached folders as additional
  workspace roots.

Creating a channel does not move the current thread into it or expand the
current session's filesystem access. Tell the user the created channel name and
attached folders so they can start a thread there.

Phi does not currently expose channel rename, folder-update, or deletion tools.
If asked for one of those operations, explain that limitation instead of
mutating runtime files directly.
