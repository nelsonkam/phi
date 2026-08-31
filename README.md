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

To keep it running in the background, install a user-level service (systemd on
Linux, launchd on macOS):

```bash
phi service install
```

That writes a per-user definition, enables it, and starts it. It runs as your
user with data in `~/.phi`. `PHI_HOST`, `PHI_PORT`, and `PHI_ROOT` are baked in
if they are set when you install. Other subcommands: `status`, `stop`, `start`,
`restart`, `uninstall`.

On Linux the service starts when you log in. Start it at boot without logging
in with `phi service install --linger`. After `phi update`, run
`phi service restart`.

## Backup and restore

Copy the Phi root (database, workspace, uploads, device token, and git-remote)
to a gzipped archive. The model cache is skipped. The archive contains secrets.

```bash
phi backup
phi backup /path/to/phi.tar.gz
```

The database snapshot is consistent while Phi is running. Restore replaces the
current root and requires that Phi is stopped:

```bash
phi service stop
phi restore /path/to/phi.tar.gz --confirm
```

If the database is still open, restore refuses and tells you to stop the
service or quit `phi serve`. Channel folders attached outside the Phi root are
not in the archive.

## Docker Sandbox

Phi can run as a persistent computer inside Docker Sandboxes. Install `sbx`
v0.42.0-rc1 or newer, configure any host-completed subscription login, then
create the version-matched Phi kit. For example, use a ChatGPT subscription
for Codex:

```bash
sbx secret set openai --oauth
phi sandbox create --name phi --port 43141
```

Claude subscription login is completed from its CLI inside the sandbox after
creation. Cursor uses a sandbox-scoped `CURSOR_API_KEY` custom secret because
Docker does not expose built-in Cursor OAuth interception to custom roots.
Codex and Claude also accept custom-secret API keys. Phi never reads provider
secrets or OAuth tokens—Docker's host-side credential proxy owns them.
`phi sandbox open`, `status`, `stop`, and `start` manage the sandbox;
`phi sandbox remove phi --confirm` permanently deletes the VM, Phi database,
repositories, worktrees, and volumes. Repeat `--kit <mixin-ref>` on create to
add inspected custom feature kits. `--port` binds Phi's internal port 3141 to a
stable IPv4 loopback port on the host, so saved browser and desktop-app URLs
survive sandbox stop/start. See [docs/docker-sandbox.md](./docs/docker-sandbox.md).

## Source checkout

```bash
bun install
bun run dev
```

`bun run start` serves without hot reload. Source checkouts update with
`git pull && bun install`.

## macOS client

The M1 macOS connection shell lives in [clients/macos](./clients/macos). It
saves and edits local and remote Phi servers, keeps remote device tokens in
Keychain, and loads each server's own UI in `WKWebView`; it never owns the
server process. Build an ad-hoc-signed local app with
`bun run build:macos-app`. The build generates its app icon from the Phi brand
asset in `assets/brand`.

On the server machine, print its device token and a secret-free macOS Add
Server link with:

```bash
phi pair --server https://machine.tailnet.ts.net --name "Home Phi"
```

Open the printed `phi://add-server?...` link, then paste the separately printed
token into the prefilled form. The durable token is deliberately never embedded
in the URL. HTTP server URLs are accepted only for loopback/SSH-forwarded
origins; remote origins require HTTPS.

## Standalone installations

Compiled macOS and Linux binaries update themselves from the latest GitHub release:

```bash
phi update
```

Restart phi afterward to run the new version. If it is installed as a service,
run `phi service restart`. `phi update` only works for the compiled binary; it
refuses a source checkout before any network call.

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
