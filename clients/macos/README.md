# Phi for macOS — M1

M1 is the connection shell: saved/editable servers, token validation, Keychain storage,
authentication-cookie injection, and the existing server-served React UI in a
`WKWebView`. It never starts or stops `phi serve`. Run the server with
`phi serve` or `phi service install`.

The app also provides bridge-free desktop notifications and a Dock badge for
the selected server. Enable notifications in **Phi → Settings**. A native
WebSocket watches for server deltas, refetches Activity, and notifies only for a
new waiting agent response while Phi is inactive. Initial connection and
reconnection establish a baseline instead of replaying old responses. Clicking
a notification loads the server's `/t/<thread-id>` URL directly in the existing
webview; there is no native/web command bridge or alternate app shell.
Badge permission is requested with notification permission, and existing
opted-in installations refresh that capability on launch.

The app icon is generated at build time from
`assets/brand/phi-logo-latex-varphi-white-on-black.png`.

The app registers the `phi://add-server` URL scheme. Run `phi pair --server
<origin>` on a server to print a deep link that prefills the name and origin,
plus the device token to paste separately. Pair links containing a token,
unknown fields, unsafe HTTP remote origins, or arbitrary routes are rejected.

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

A loopback URL may also keep a token. This supports SSH-forwarded and
host-mapped sandbox servers whose traffic reaches Phi as non-loopback inside the
container. Leaving the token blank while editing preserves the saved value;
entering one replaces it.

> **Remote safety:** do not expose the current Phi server through a public bind
> or reverse proxy yet. The client is remote-capable, but server-wide API and
> WebSocket authentication plus proxy-aware loopback detection still need to
> land. Use the macOS client against loopback for now.

The connection model, Keychain/API code, WebSocket client, and notification
baseline logic live in `PhiClientCore` so they can move into the future iOS
target. The rejected M2 native-navigation shell is not part of the app.
