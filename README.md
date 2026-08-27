# phi

Phi is a small knowledge-work harness: a persistent coordinator, a web UI, and
delegated workers in a shared workspace.

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

Set `PHI_UPDATE_REPO` to an alternate `owner/repository`. Private releases use
`GITHUB_TOKEN` or the authenticated GitHub CLI.

## Releasing

Pushing a `v*` tag runs the release workflow: it typechecks, tests, compiles
and signs standalone macOS arm64/x64 binaries, and publishes them to a GitHub
release. Tags containing `-` are marked prerelease so they stay off
`releases/latest`. Build one or both artifacts locally with:

```bash
bun run build:release -- bun-darwin-arm64 bun-darwin-x64
PHI_ONNX_PROBE=1 ./dist/release/phi-darwin-arm64
```
