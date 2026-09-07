# Lina desktop

An Electron client for an independently running Lina web server. The app bundles
exactly the renderer built by `lina-web/src/assets.ts`; it does not start an
execution engine, web development server, or Bun at runtime.

## Build and run

From the repository root, install the committed workspace lockfile with lifecycle
scripts disabled, then build or package:

```sh
bun install --frozen-lockfile --ignore-scripts
bun run --cwd packages/lina-desktop build
bun run --cwd packages/lina-desktop package
bun run --cwd packages/lina-desktop make
```

`package` produces the application directory under `out/`; `make` additionally
produces a ZIP for the current platform. Neither command publishes, signs, installs
an OS service, or changes a running Lina server. Forge downloads Electron as part
of packaging; no trusted install hook is added. Use Node >=22.12 for Forge.

Linux example, connecting to an explicitly selected Lina web gateway:

```sh
LINA_DESKTOP_SERVER_URL=http://127.0.0.1:18140 \
LINA_DESKTOP_PORT=18141 \
LINA_DESKTOP_USER_DATA=/tmp/lina-desktop-example/desktop \
packages/lina-desktop/out/Lina-linux-x64/lina-desktop
```

For development, `bun run --cwd packages/lina-desktop start` uses an already
provisioned Electron binary. An ignored install script is not permission to turn
on dependency hooks. Packaging provides a separate executable without such a hook.

| Setting | Meaning |
| --- | --- |
| `LINA_DESKTOP_SERVER_URL` | Required exact `http://127.0.0.1:PORT` or `http://[::1]:PORT`; points to Lina **web**, not the intervention socket |
| `LINA_DESKTOP_PORT` | Stable broker port, default `43127`; QA reserves `18141` |
| `LINA_DESKTOP_USER_DATA` | Absolute isolated profile path; default `$LINA_HOME/desktop` or `~/.lina/desktop` |
| `LINA_DESKTOP_EXTERNAL_ORIGINS` | Comma-separated exact HTTPS origins allowed in the OS browser; default `https://github.com`; an empty value denies all |

The app never falls back to another broker port. `connection.json` binds the
profile to its configured server and broker port. Reusing a profile with either
changed is rejected; use a separate profile to avoid mixing old drafts with a
different server. Electron session data lives in the profile's `sessions/`
directory and the `persist:lina-desktop` partition. The server setting must be
provided on each launch; it is not inferred from open ports or renderer input.

## Transport and process boundary

The renderer uses its ordinary same-origin fetch and `/ws` contracts:

```text
shared renderer → authenticated 127.0.0.1 broker → pinned Lina web gateway
                     Electron main                   existing Host/Origin checks
```

The existing server creates browser assets with Bun. A `file://` renderer would
break its same-origin API, attachment and WS paths, while loading remote server
HTML would make the desktop shell unavailable offline. This package instead
writes the existing `loadWebAssets()` output to a checksummed disk manifest and
serves it from main's loopback broker. Only web/PWA metadata and service-worker
files are omitted. Shared model/parser code remains owned by `lina-client` and
Lina web; no copied engine or wire model lives in this package.

`src/config.ts` validates operator configuration; `session.ts` owns the ephemeral
credential and persistent profile binding; `routes.ts` is the desktop egress
allowlist; `broker.ts`, `http-proxy.ts`, and `socket-proxy.ts` implement Node
transport; `window.ts` owns Electron/OS policy. Bun-dependent build code stays in
`scripts/`. Runtime code only imports Node builtins and Electron.

The broker accepts only a main-generated 256-bit credential installed directly
with `session.cookies.set` before navigation. No HTTP route issues or returns it.
The cookie is host-only, HttpOnly, SameSite=Strict, and session-only; it rotates
on every main-process start. `secure: false` is intentional for the literal
loopback HTTP origin. Cookies have no port boundary, so Electron blocks requests
to every other origin before networking; the broker separately validates exact
Host and Origin. The cookie is never forwarded upstream or exposed by preload.

HTTP forwarding validates raw path, method, query, and bounded bodies. It allows
only the existing attachment, agent, model, hub, task, onboarding and intro
contracts. It sets upstream Host/Origin for the pinned destination, rejects all
redirects, and forwards only required metadata. Upstream Set-Cookie and Location
are dropped. Attachment authorization and domain schemas still run on Lina.

WS forwarding validates the cookie, exact Origin, `/ws?agent=...`, handshake
version/key and upstream accept value. It does not follow redirects or negotiate
extensions/subprotocols. Node streams provide backpressure; the existing Lina web
gateway retains frame parsing and payload limits. At most eight desktop tunnels
are accepted. Closing the window/app closes transport; it does not stop server
work. HTTP failures return 502; existing shared-renderer retry and WS reconnect
behavior can recover while bundled assets remain available.

## OS surface

The window enables `sandbox`, `contextIsolation`, and `webSecurity`, disables Node
integration/webviews, denies permission requests and foreign navigation, and
installs the normal Edit/View/Window menus. One instance owns each profile.
macOS keeps the app alive when its window closes and reopens it on activation;
other platforms quit when all windows close. Quitting flushes browser storage and
closes broker connections.

Preload exposes only:

```ts
window.linaDesktop = {
  platform: "desktop",
  openExternal(url: string): Promise<void>,
  notify(input: { title: string; body: string }): Promise<boolean>
}
```

Every OS IPC call checks the owning webContents and main frame, validates input,
and uses a dedicated channel. There is no general IPC, file-path read, shell
command, credential, or transport API. Shared UI uses the marker to skip PWA
registration. Native file inputs and ordinary attachment downloads keep their
existing browser behavior; validated attachment downloads use the native save
dialog. Notifications accept only bounded title/body text. The existing “Codex에서 열기”
control opens only `codex://threads/<id>` with 1–128 ASCII letters, digits,
underscores or hyphens. Validation checks the raw URI before normalization;
commands, nested/encoded paths, credentials, ports, query and fragment are denied.
This opens the registered OS handler for that existing thread and never creates
another task. A missing/broken handler produces a native error dialog and rejects
an IPC request. HTTPS links still require exact allowlisted origins; register the
OpenCodex hub's HTTPS origin, including a nondefault port, explicitly when needed. App updates, signing,
IME/paste qualification and additional native OS capabilities need separate proof.

## Threat model and verification

Assets are local conversations/drafts, uploaded files and the broker credential.
Entry points are HTTP/WS headers and paths, renderer IPC, navigation, downloads and
operator configuration. A hostile website or forged local browser request must
not reach Lina through the desktop broker, learn its token, select another
upstream, or gain arbitrary OS capabilities. The explicitly configured Lina web
service and the OS account running main are trusted. This is not isolation from
a malicious process already able to read that account's memory/profile files.

Must-pass checks cover missing/duplicate/wrong cookies, Host/Origin mismatch,
cross-port requests, path/query/method rejection, redirects and invalid WS
handshakes, metadata preservation, body bounds, offline recovery, profile binding,
IPC sender/subframe rejection, and the absence of broad preload capabilities.
Tests use real loopback servers and explicit events, with no sleep or provider
calls. `web-contract.test.ts` traverses the actual unchanged Lina web gateway;
`node-runtime.test.ts` builds and runs the broker in a separate Node process.

```sh
bun test packages/lina-desktop/test
bun run --cwd packages/lina-desktop typecheck
bunx --no-install biome check packages/lina-desktop --diagnostic-level=warn
bun run --cwd packages/lina-desktop package
bun scripts/ci/audit.ts
```

Runtime TypeScript uses DOM + Electron's referenced Node declarations. Build/tests
use the repository's Bun configuration in `tsconfig.build.json`. The root compiler
must exclude this package and call its separate check, avoiding Electron's DOM
fetch declarations leaking into Bun server source.

## Version evidence and qualification

Checked 2026-09-07: [Electron stable releases](https://releases.electronjs.org/?channel=stable)
listed **44.2.0**, also verified against installed package metadata and the Linux
artifact's `version` file. [Forge 8.0.0-alpha.10](https://github.com/electron/forge/releases/tag/v8.0.0-alpha.10)
is explicitly a **prerelease**. Its official change list replaces extract-zip,
and its registry metadata moves to packager 20/rebuild 4. It is selected because
the latest stable Forge 7.11.2 introduced failing repository audit findings in
extract-zip 2.0.1, tar 6.2.1 and tmp 0.0.33. The
[extract-zip advisory](https://github.com/advisories/GHSA-jmr9-qjv8-65gv)
has no fixed version under that package name. No audit finding is suppressed. The final installed graph used packager **20.3.0**,
rebuild **4.2.0**, electron-internal/extract-zip **1.0.5**, and tar **7.5.22**;
extract-zip and tmp were absent. `bun scripts/ci/audit.ts` passed both the lockfile
check (135 packages) and installed-package check (129 names). No root overrides
were needed. Obsolete Forge 7 store entries were preserved outside `node_modules`
after checking the new lockfile and reachable dependency links; this avoids stale
packages contaminating the installed inventory without changing audit policy.
Forge 8 `package` and `make` both completed on Linux x64. The executable basename
was verified as `out/Lina-linux-x64/lina-desktop`; ZIP output is
`out/make/zip/linux/x64/Lina-linux-x64-0.1.0.zip`.

Quit cleanup runs on `will-quit`, after all windows have closed, so a renderer
that vetoes closing for an unfinished upload retains its transport.
`lifecycle.test.ts` exercises the compiled main entry with controlled Electron
boundaries; this does not replace the remaining graphical acceptance. See the
[app lifecycle](https://www.electronjs.org/docs/latest/api/app#event-will-quit).

Security API references: [Electron security](https://www.electronjs.org/docs/latest/tutorial/security),
[cookie API](https://www.electronjs.org/docs/latest/api/cookies), and
[session API](https://www.electronjs.org/docs/latest/api/session).

Initial RED runs failed on the absent `config.ts`, `broker.ts`, bundle writer and
`window-policy.ts` before their implementation. A later real contract RED returned
405 for onboarding draft PATCH; fixing that route and memory refresh POST restored
the transport suite. The Codex thread link test then failed with “Only HTTPS links
without credentials are allowed”; the strict thread exception passed the same
positive/negative test. An OS-handler failure initially produced no dialog; the
shared native-error boundary made that regression pass.

The native Node regression also reproduced an unhandled `write ECONNRESET` when
an unauthenticated upgrade peer called `resetAndDestroy()` immediately after its
write. No upstream connection is reached on that path, isolating the fault to the
rejection socket after Node removes its HTTP error listener. `rejectUpgrade` now
installs its error listener before every rejection write. Repeating those TCP
resets and then a successful authenticated HTTP request passes in Node and the
packaged Electron Node runtime. Scope-local verification results are recorded in the executor
handoff; repeat them after shared-renderer or dependency changes.

The first Linux graphical launch reached Chromium but aborted because the
`chrome-sandbox` helper lacked root ownership/mode 4755. `unshare -Ur true` also
failed with `Operation not permitted` on this host. No sandbox flag, host policy,
or privileged permission was changed. Therefore Linux graphical UI, browser
storage across a real Electron restart, OS dialogs and notifications are **not yet
qualified here**. The packaged Electron executable did run the compiled broker
successfully with `ELECTRON_RUN_AS_NODE=1`; that proves its Node transport runtime,
not the sandboxed renderer. macOS/Windows launch and packaging remain untested.
