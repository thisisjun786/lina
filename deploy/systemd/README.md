# Lina user services

`lina-app-codex.service` runs `packages/lina-runtime/scripts/start-codex.ts`.
`lina-app-web.service` runs the web gateway after that Codex backend. Both templates
use the current user manager's `%h` home and a checkout at `%h/code/Lina`; adjust
the checkout and Bun paths before installing. They contain no credentials.
Provider accounts and model routing belong to OpenCodex. The Codex executable
must be on the configured PATH or set with `LINA_CODEX_COMMAND`.

After reviewing the source and choosing the intended state location, install as
user units:

```sh
mkdir -p ~/.config/systemd/user
cp deploy/systemd/lina-app-codex.service.template ~/.config/systemd/user/lina-app-codex.service
cp deploy/systemd/lina-app-web.service.template ~/.config/systemd/user/lina-app-web.service
systemctl --user daemon-reload
systemctl --user enable --now lina-app-codex.service lina-app-web.service
```

The Codex template sets `LINA_HOME` to `~/.lina`. Existing Codex state can be
selected explicitly under the [startup rules](../../docs/CODEX_RUNTIME.md).
Legacy Senpi transcripts cannot be imported into Codex; keep them and their
backups separately. `LINA_IMPORT_SESSION` is rejected. This source change does
not move data, replace installed units or restart any running process.

For an existing installation, first inspect active conversations, approvals and
Codex tasks. Stop only the owned services once their work can safely stop, back
up the selected state, and install the reviewed units. An old installed
`lina-app-sdk.service` continues to reference a retired entry point: retire that
unit explicitly during the authorized operational migration. Do not enable both
backends against the same state directory or copy old data over newer data.

Template and executable checks establish source wiring. They do not establish
that a user's systemd manager loaded the new units or that a provider call works.
