# Phi for macOS — M1

M1 is the connection shell: saved/editable servers, token validation, Keychain storage,
authentication-cookie injection, and the existing server-served React UI in a
`WKWebView`. It never starts or stops `phi serve`.

The app icon is generated at build time from
`assets/brand/phi-logo-latex-varphi-white-on-black.png`.

Requirements: macOS 14+, Xcode 16 / Swift 6.

```bash
bun run test:macos
bun run build:macos-app
open clients/macos/dist/Phi.app
```

`This Mac` points to `http://127.0.0.1:3141` and uses Phi's loopback session
bootstrap. A remote connection must use HTTPS and currently needs the server's
device bearer from `$PHI_ROOT/device-token` (or its configured
`PHI_API_TOKEN`). The app validates it with `GET /api/v1/auth/session`, stores
it in Keychain, and inserts it as the HttpOnly `phi-device` cookie for that
origin before loading the UI. It never places the token in preferences, URLs,
logs, or the web page's JavaScript.

> **Remote safety:** do not expose the current Phi server through a public bind
> or reverse proxy yet. The client is remote-capable, but server-wide API and
> WebSocket authentication plus proxy-aware loopback detection still need to
> land. Use the macOS client against loopback for now.

The connection model and Keychain/API code live in `PhiClientCore` so they can
move into the future iOS target. M2 adds native product navigation and OS
integration; it does not replace this connection layer.
