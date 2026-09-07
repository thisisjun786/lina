# Lina-owned Honcho

These optional service templates target Honcho 3.1.0, pinned to upstream commit
`a026bebdef91e2b0d052574a653afc39b3ad3918`. They describe configuration, not an
already running service. Existing service data is not adopted automatically.

## Runtime

`compose.yml` owns project `lina-honcho`, its database/cache volumes, API and deriver.
API listens on `127.0.0.1:8010`; PostgreSQL on `127.0.0.1:15431`; Redis on
`127.0.0.1:16381`. API/deriver use host networking for the local database/cache; the services
remain bound to loopback. Honcho auth is disabled inside this local boundary.
The database is separate from OpenViking and any other application.

LLM calls go directly to `https://ollama.com/v1` with the saved Ollama Cloud key.
Deriver and light dialectic use `deepseek-v4-flash:0731`; summaries and medium/high
dialectic use `glm-5.3-flash`; max dialectic/dream deduction use `glm-5.3`;
dream induction uses `deepseek-v4-pro:0813`. These are the template model-role selections.
Provider-enforced JSON schema is not assumed:
Honcho validates the returned data and records failures. See
[Ollama's stated cloud limitation](https://docs.ollama.com/capabilities/structured-outputs).
The external service owns these direct provider calls and their cost.
Embeddings use OpenGateway `sionic-ai/comsat-embed-ko-8b-preview`, 2048 dimensions,
with `halfvec(2048)` columns and HNSW indexes. Models run remotely; memory data is
stored in this self-hosted database.

Prepare secrets in ignored, mode0600 files:

- `runtime/compose.env`: `LINA_HONCHO_DB_PASSWORD`.
- `runtime/service.env`: `AUTH_USE_AUTH=false`, `LOG_LEVEL=WARNING`,
  `OLLAMA_API_KEY`, `EMBEDDING_MODEL_CONFIG__OVERRIDES__API_KEY`.

Supply credentials authorized for this service. The templates do not copy keys
from other applications or establish permission to reuse them.
Never print these files or pass secrets in command arguments.

## Rebuild / startup

Build from the pinned source into the local `lina-honcho:3.1.0` image. Retain the
upstream license and source checkout; do not build an unpinned main branch.

```sh
git clone https://github.com/plastic-labs/honcho.git /tmp/lina-honcho-build
git -C /tmp/lina-honcho-build checkout a026bebdef91e2b0d052574a653afc39b3ad3918
docker build -t lina-honcho:3.1.0 /tmp/lina-honcho-build
```

From the Lina root, with the two local environment files prepared:

```sh
docker compose --env-file deploy/honcho/runtime/compose.env -f deploy/honcho/compose.yml up -d database redis
# Apply upstream Alembic migrations before first API startup:
docker compose --env-file deploy/honcho/runtime/compose.env -f deploy/honcho/compose.yml run --rm --entrypoint /app/.venv/bin/alembic api upgrade head
# This script refuses a nonempty embedding/document database. Fresh installs only.
docker exec -i lina-honcho-database-1 psql -v ON_ERROR_STOP=1 -U lina_honcho -d lina_honcho < deploy/honcho/schema-new.sql
docker compose --env-file deploy/honcho/runtime/compose.env -f deploy/honcho/compose.yml --profile inference up -d
```

Services use Docker `restart: unless-stopped`; volumes survive service recreation.
Never use `down -v` as a routine update. Back up PostgreSQL before upgrading the
image or changing vector dimensions. The schema script is not a migration for an
existing memory database.

## Agent scopes and readiness

Root `.env` enables memory with `LINA_HONCHO_BASE_URL`, `LINA_HONCHO_WORKSPACE_ID`,
`LINA_HONCHO_SESSION_ID`, `LINA_HONCHO_USER_PEER_ID` and
`LINA_HONCHO_OBSERVER_PEER_ID`. All unset means no network calls; partial config
is rejected. The fleet keeps the configured user peer and derives its session
and observer IDs per agent. Before upgrading an existing Honcho installation,
set `LINA_HONCHO_USER_PEER_ID` to the actual peer that owns its existing messages.
Earlier versions could ignore this setting in fleet mode; a previously ignored
value is not proof of the identity in use. Do not rename the external peer or
change the setting to a new identity as part of an ordinary source update.
Changing the user peer changes recall scope. Each
agent retains its own local outbox. New configured agent scopes are initialized
on first use. An unavailable service does not prevent ordinary conversation.

Check three different outcomes before declaring memory operational:

1. Capture: remote receipts match scope, sender, content hash and source ID.
2. Derivation: representation tasks complete without errors and conclusions exist.
3. Recall: the observer's session-scoped representation returns relevant conclusions.

An HTTP200 or an accepted message is not derivation proof. `freshness: unknown`
remains honest even when recall succeeds; the derivation queue is asynchronous.

## Adapter guarantees and limits

Messages are split into at most1500 UTF-8 bytes per part. Originals remain local.
Receipts/reconciliation compare exact workspace/session/peer/content and
`metadata.lina = {entryId,partIndex,contentHash}`. Writes have no blind retry:
`unknown` outcomes are reconciled before any resend. Service outages preserve the
outbox. Each request is bounded to2 seconds and256KiB. Recall sends a bounded
query excerpt and returns at most4096 characters; failure lets chat continue.

No memory-forget UI is claimed: deleting messages has not been proven to remove
all derived conclusions on this pinned version. Persona's revert control changes
local character dynamics, not Honcho's source messages or conclusions.
