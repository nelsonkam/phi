# phi

Phi is a small knowledge-work harness: a persistent coordinator, a web UI, and
delegated workers in a shared workspace.

## Install

Each release publishes standalone macOS and Linux binaries — no Bun installation
required. [scripts/install.sh](./scripts/install.sh) picks the binary for the
host, installs it to `~/.local/bin/phi`, and tells you if that directory is not
on your `PATH`:

```bash
curl -fsSL https://raw.githubusercontent.com/nelsonkam/phi/main/scripts/install.sh | sh
```

`PHI_INSTALL_DIR` chooses the install directory, `PHI_VERSION` pins a release
tag instead of the latest, and `PHI_UPDATE_REPO` installs from another
repository. A private `PHI_UPDATE_REPO` needs authenticated `gh` (`gh auth
login`); the installer does not send `GITHUB_TOKEN`. Piping a script into a
shell runs it unread — `curl -fsSL …` on its own prints exactly what would
run.

Otherwise, download the matching `phi-<platform>-<architecture>` from GitHub
Releases, make it executable, and run it.

Start the server and UI:

```bash
phi serve
```

`phi` with no command does the same. It listens on http://127.0.0.1:3141.
`PHI_HOST` and `PHI_PORT` override the bind address and port. Phi previously
relied on Bun's wildcard bind default; the explicit loopback default is a
security hardening change for native installations that were reachable from
the local network.

## Docker Sandbox

Phi can run as a persistent computer inside Docker Sandboxes. Install `sbx`
v0.42.0-rc1 or newer, configure any host-completed subscription login, then
create the version-matched Phi kit. For example, use a ChatGPT subscription
for Codex:

```bash
sbx secret set openai --oauth
phi sandbox create --name phi
```

Claude and Cursor subscription logins are completed from their CLIs inside the
sandbox after creation. The official kit is OAuth-only; API-key users can add
an sbx custom secret scoped to the sandbox. In both cases Phi never reads
provider secrets or OAuth tokens—Docker's host-side credential proxy owns
them. `phi sandbox open`, `status`, `stop`, and `start` manage the sandbox;
`phi sandbox remove phi --confirm` permanently deletes the VM, Phi database,
repositories, worktrees, and volumes. Repeat `--kit <mixin-ref>` on create to
add inspected custom feature kits. See [docs/docker-sandbox.md](./docs/docker-sandbox.md).

## Source checkout

```bash
bun install
bun run dev
```

`bun run start` serves without hot reload. Source checkouts update with
`git pull && bun install`.

## Standalone installations

Compiled macOS and Linux binaries update themselves from the latest GitHub release:

```bash
phi update
```

Restart phi afterward to run the new version. `phi update` only works for the
compiled binary; it refuses a source checkout before any network call.

Set `PHI_UPDATE_REPO` to an alternate `owner/repository`. `phi update` reads
private releases with `GITHUB_TOKEN` or authenticated `gh`. The installer
does not: a private install source needs `gh auth login`.

## Releasing

Pushing a `v*` tag runs the release workflow: it typechecks, tests, compiles
standalone macOS and Linux arm64/x64 binaries, probes their native ONNX and ACP
runtime paths, and publishes them to a GitHub release. macOS binaries are
ad-hoc signed. Tags containing `-` are marked prerelease so they stay off
`releases/latest`. Build one or both artifacts locally with:

```bash
bun run build:release -- bun-darwin-arm64 bun-darwin-x64 bun-linux-arm64 bun-linux-x64
PHI_ONNX_PROBE=1 ./dist/release/phi-darwin-arm64
```
