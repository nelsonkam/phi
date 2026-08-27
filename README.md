# phi

Phi is a small knowledge-work harness: a persistent coordinator, a web UI, and
delegated workers in a shared workspace.

## Install

Each release publishes standalone macOS binaries — no Bun installation
required. [scripts/install.sh](./scripts/install.sh) picks the binary for this
Mac, installs it to `~/.local/bin/phi`, and tells you if that directory is not
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

Otherwise, download `phi-darwin-arm64` or `phi-darwin-x64` from GitHub
Releases, make it executable, and run it.

Start the server and UI:

```bash
phi serve
```

`phi` with no command does the same. It listens on http://localhost:3141
(`PHI_PORT` overrides).

## Source checkout

```bash
bun install
bun run dev
```

`bun run start` serves without hot reload. Source checkouts update with
`git pull && bun install`.

## Standalone installations

Compiled macOS binaries update themselves from the latest GitHub release:

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
and signs standalone macOS arm64/x64 binaries, and publishes them to a GitHub
release. Tags containing `-` are marked prerelease so they stay off
`releases/latest`. Build one or both artifacts locally with:

```bash
bun run build:release -- bun-darwin-arm64 bun-darwin-x64
PHI_ONNX_PROBE=1 ./dist/release/phi-darwin-arm64
```
