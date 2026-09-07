# LINA image engine: ima2-gen

Date: 2026-09-07. Status: first image slice implemented and qualified through ima2 OAuth / gpt-5.6-luna.
Parent: [Installable LINA refactor preparation](008_refactor_preparation.md).
Upstream: [ima2-gen](https://github.com/lidge-jun/ima2-gen).

## Decision

Adopt ima2-gen as LINA's image-generation engine and ecosystem integration.
The adapter attaches to Lina-owned tools in `lina-runtime`, registered by the Codex session host. Source verification and authorized external generation qualification are separate acceptance steps.

LINA owns user intent, conversation and agent association, job tracking, and result
delivery. ima2 owns visual generation, its provider connections, and its studio.
Keep ima2 as a separately versioned runtime behind a narrow adapter. Treat image
generation as an optional capability for modular LINA installs; exact LINA OS
bundling and provisioning details remain implementation decisions.

## Connection and discovery contract

- Present image-generation connections separately from conversation-model settings.
- Read provider lanes, available models, readiness and supported operations from
  the connected ima2 runtime. Do not hardcode the model list from this discussion.
- Candidate discovery interfaces are `ima2 models --kind image --json` and
  `GET /api/models`; verify their schemas against the pinned implementation.
- Support ima2-owned setup and configuration. Surface connection status and an
  appropriate setup entry from LINA; do not require routine CLI use in the final UX.
- Distinguish configured credentials, service availability, catalog readiness, and
  a successful real generation. A catalog row is not proof of generation success.
- Do not assume that LINA/OpenCodex credentials are automatically shared with ima2.
  Reuse existing authentication only where the pinned integration supports it.
- Select image provider/model explicitly. Do not silently change provider or billing
  route on failure. Expose unavailable capabilities honestly.

## First implementation slice

One user request generates one image, displays it in the originating LINA
conversation, and permits a follow-up edit using that same image as a reference.

- Map agent/conversation IDs to the upstream request and terminal result.
- Preserve progress, failure and cancellation semantics supported by the pinned
  runtime. Reconcile uncertain jobs before retrying to avoid duplicate generation.
- Import successful results into LINA's managed attachment/artifact storage with
  provenance. Verify bytes, media type and ownership before displaying them.
- Retain the image and its conversation association across LINA restarts; deliver
  completion once. Keep credentials out of artifacts and diagnostic records.
- Check server discovery and lifecycle rather than assuming port 3333. Service
  ownership must distinguish a LINA-managed runtime from an existing user runtime.

Video, batch generation and opening ima2 Studio for detailed manual editing are
subsequent extensions, outside the first slice.

Additional user ideas: [periodic avatars and a Twitter-like agent daily-life feed](010_agent_daily_life_ideas.md).
These remain an idea backlog and do not expand the first implementation slice.

## Acceptance before claiming integration complete

1. A fresh connection exposes the actual provider/model list and actionable setup
   errors without fabricated ready states.
2. An explicitly selected provider creates a real image that appears in the
   original conversation; follow-up editing uses the correct source artifact.
3. Authentication failure, unavailable model and server outage produce clear errors
   without an unrequested provider switch.
4. Restart/recovery preserves completed images and prevents duplicate completion
   delivery or blind resubmission of an uncertain request.
5. Verify runtime version, discovery schema, generation/edit contracts and actual
   provider behavior during implementation. Start behavior changes with failing
   tests as required by the repository guide.

## Reference scope

The upstream [CLI documentation](https://github.com/lidge-jun/ima2-gen/blob/main/docs/CLI.md)
and README for setup, discovery and generation interfaces; these are implementation
leads, not pinned compatibility or end-to-end evidence.

External qualification for the selected route is recorded below. Additional generation calls and service changes remain separately authorized.


## Local implementation

The adapter is pinned to **ima2-gen 3.14.0**, source revision
[`36aa6fcea62f753d858d20c4823e04922951c954`](https://github.com/lidge-jun/ima2-gen/tree/36aa6fcea62f753d858d20c4823e04922951c954).
Other versions fail with `UNSUPPORTED_VERSION` until their contracts are qualified.
The runtime remains external: Lina does not install, launch, stop, or update it.

| Owner | Responsibility |
| --- | --- |
| `packages/lina-runtime/src/images/client*.ts` | Discovery, health/catalog parsing, explicit selection, submit/read/cancel, bounded result download |
| `packages/lina-runtime/src/images/store.ts` | Session-bound job identity, state and provenance under the existing app lifetime lease |
| `packages/lina-runtime/src/images/jobs.ts` | Reconciliation, cancellation intent, managed attachment import, durable completion delivery |
| `packages/lina-runtime/src/images/tools.ts` | `lina_image_models`, `generate`, `edit`, `jobs`, `read`, `cancel` tools using the existing Codex authorization boundary |
| `packages/lina-runtime/src/session-app.ts` | Registration, per-session storage and lifecycle; existing Codex notice writer handles conversation delivery |
| `packages/lina-core/src/attachments/store.ts` | Immutable bytes, MIME/container checks, hash and ownership; stable artifact IDs support crash-safe import replay |
| `packages/lina-web/client/markdown*.ts` | Same-session managed image previews inside existing assistant messages |

Existing attachment, control and notice owners were located before adding this adapter.
The Codex task manager owns native coding sessions and cannot represent ima2 jobs;
its existing notice delivery is reusable, while image execution needs separate state.
No new engine SDK or package dependency is introduced. UI redesign, world logic,
video, batches, masks and Studio workflows remain outside this change.

### Connection and use

Start and configure ima2 separately using its own setup interface. Lina discovers
its actual address from `~/.ima2/server.json` (`backend.url`), or the owner can set
`LINA_IMA2_URL` to an explicit HTTP(S) origin. `LINA_IMA2_SERVER_FILE` overrides the
local discovery path. Credentials embedded in URLs, redirects and arbitrary result
URLs are rejected. File-based discovery is restricted to loopback; an explicit origin
may be remote. This slice does not forward cookies or bearer/LAN tokens, so a remote
service must already permit these requests. Protected services return an access
error; Lina does not weaken their authentication.

In the existing conversation, ask Lina to inspect image connections. The
`lina_image_models` tool returns the setup URL, live catalog and operation support,
with service ownership marked external and prior verified generation records listed
separately. Choose an exact provider/model, request one image, then refer to that
image for a follow-up edit. The tool supplies the saved attachment ID and its checked
bytes as the edit reference. No provider or billing route changes automatically.

Catalog entries are read from ima2, including unavailable lanes. Adapter operation
support also checks the pinned generation route: an unknown lane must never fall
through to ima2's default provider. Lanes whose explicit selection or reference
contract is unsupported remain visible but cannot generate/edit through this slice.

Both creation and reference editing use `POST /api/generate` with `async: true`,
`n: 1`, explicit provider/model, and the same durable UUID for request and idempotency
identity. This intentionally uses generation with an image reference: upstream's
synchronous `/api/edit` does not supply the same recovery contract.

### State, ownership and recovery

The current conversation binding fixes the agent, session, workspace and journal.
Image records live in its `images/jobs.json`, independently of Codex work-session
state. Each record retains the original chat request/call, provider/model, selected
endpoint/version, source artifact ID and resulting attachment metadata.

The adapter records submission intent before its first generation request. A lost
response stays uncertain; restart and `lina_image_read` only reconcile the same ID
using `/api/inflight?includeTerminal=1` and exact request-filtered history. Expired
idempotency/terminal records never authorize another generation. A changed endpoint
or runtime version cannot inherit an old request. One unresolved image job blocks a
new generation in that conversation until its outcome is resolved. If ima2 has lost
both the terminal and history records, the job remains uncertain and requires
operator investigation in ima2. This slice provides no discard/force-retry bypass.
Existing attachments remain readable; restoring upstream evidence permits normal
reconciliation to continue.

Queued, running and post-processing states remain visible. Cancellation intent is
saved immediately, including while a preceding status read or submit is blocked.
It survives restart and is retried only against an observed
active job. A cancellation acknowledgement is not proof that a provider stopped or
refunded the request. A completed result racing cancellation is retained.

Results must be one valid PNG or JPEG within the existing **2 MiB** attachment limit.
The generated filename is resolved only under the selected ima2 origin; Lina verifies
its media type, container, dimensions and hash before import. Larger or unsupported
outputs become a terminal import failure, retain the upstream filename/request
identity, and are not displayed. They do not block a later explicitly requested
generation. Transport failures during import remain uncertain. Stable artifact IDs retain
identical bytes across replay and reject conflicts without overwriting files.

The existing Codex notice journal records `image_<jobId>` before delivering a message.
An active conversation defers that notice until idle. Restart recognizes the same
marker even if the local delivery receipt was not saved. The journal stores the
full message, not just a sent flag: the conversation snapshot replays it after a
crash before browser delivery. A delivery failure is recorded separately from the
image result, retried later, and does not prevent application shutdown. Only matching-session
attachment preview URLs render as images; external URLs, data URLs and foreign-session
references stay text. Original images remain available after editing.

### Verification and external-call gate

Local verification uses synthetic temporary state and local fake dependencies, never
production conversations, model credentials or an existing daemon. Contract fixtures
come from the pinned source, rather than an invented provider schema. Tests cover
submission uncertainty, wrong model/authentication, outage, result validation,
reference ownership, concurrent read/cancel, cancellation recovery, artifact replay,
notice deferral and restart. Independent review also reproduced and closed a
shutdown failure after a rejected notice, the oversized-output admission block,
and cancellation intent lost behind a pending read. Each has a failing-then-passing
regression. The original affected package suites remain required.

Run the affected suites and source gates:

```sh
bun test packages/lina-core/test packages/lina-runtime/test packages/lina-codex/test packages/lina-web/test
bun run typecheck
bun run lint
bun run ci:validate
bun run ci:build
```

Before external qualification, obtain approval for a named provider/model and exactly
one generation plus one reference edit. Use a separate temporary Lina state root and
workspace, an owned test conversation, and the configured external ima2 runtime.
Record the exact runtime/provider/model, two upstream request IDs, attachment hashes,
observed browser output, and restart/deduplication results. A passing fake HTTP test,
model catalog, or source build must never be reported as a real provider call.

Local browser harness:

```sh
bun packages/lina-web/scripts/qa-image-engine.ts
```

Open the printed URL and send `generate`, then `edit`. This uses the real Lina
Codex adapter with synthetic RPC, a local fake ima2 server, isolated state and
320×200 blue/green PNG fixtures. `generate fail` exercises failure. No external
provider call occurs. The harness omits the unrelated fleet/task API; browser
acceptance stubs that sidebar to an empty task list. Browser checks confirmed both
images loaded, the original attachment stayed unchanged, refresh restored both,
and a 390px viewport had no horizontal overflow. A separate integration test
restarts the actual app and reuses its Codex notice journal and attachment files.

Local verification on `codex/image-engine`, based on `dev` at `e41ce13`:

| Check | Result |
| --- | --- |
| `bun test` | Exit 0; 1,429 passed, 0 failed; 6,485 assertions across 196 files |
| `bun run typecheck` | Exit 0; root and browser TypeScript |
| `bun run lint` | Exit 0; 5 existing warnings, no errors |
| `bun run ci:validate` | Exit 0; workflow, setup, forms and contribution links |
| `bun run ci:build` | Exit 0; runtime assets and read-only CLI smoke |
| Independent code review | PASS after four reproduced findings were repaired |
| Browser | Synthetic generation/edit, image bytes loaded, reload restored both; desktop and mobile checked |

These local results were collected before PR publication. They do not certify a
merge or deployment.
The isolated fake Codex driver and fake ima2 server prove adapter wiring and
persistence, not real model reasoning or provider generation quality. The separately
approved provider qualification is recorded below.

UI evidence: [desktop](009_ima2_image_engine_desktop.png) and
[390px mobile](009_ima2_image_engine_mobile.png). These screenshots show the local
synthetic harness described above, not external generation. The blue and green
rectangles are deterministic fixtures created by the included QA script; their
only inputs are dimensions and color values. The screenshots contain Lina's UI and
synthetic test messages, with no third-party image inputs or private conversation
data, and are contributed under the repository's Apache-2.0 license.

External generation: **PASS for OAuth / gpt-5.6-luna: one creation and one reference edit.**
Push, merge and deployment remain separately authorized actions.


### ChatGPT connection qualification (2026-09-07)

After the owner authorized account connection, ima2-gen 3.14.0 was installed in a
separate local runtime directory. The npm package reports the same `gitHead` as the
pinned source. Its offline installation doctor passed all eight checks.

The supported `ima2 login` path recognized the existing file-backed Codex ChatGPT
session. No new browser login or manual credential copy was needed. ima2's OAuth
proxy loaded the account's model list from the authenticated Codex endpoint, then
`/api/oauth/status` returned `ready`. The Lina `Ima2Client` successfully parsed the
actual ima2 catalog. A controlled restart retained the configuration and returned
to the same ready connection.

The configured image catalog and the account's model list are different surfaces;
`oauth/gpt-5.6-luna` is present in both. Connection qualification itself sent no
image-generation request; the later approved generation is recorded separately
below. Automatic startup at login/reboot and deployment into the user's running
Lina installation were not configured.


### Authorized live image qualification (2026-09-07)

The owner approved exactly one creation and one reference edit through
`oauth/gpt-5.6-luna`. Both requests succeeded against the separately installed
ima2-gen 3.14.0 runtime. Each upstream history entry reports 29.9 seconds.

| Operation | Upstream request ID | Result |
| --- | --- | --- |
| Create | `da6bbe17-b55c-4f56-94a3-a70b0df30530` | Blue robot with an orange hat; PNG, 1254×1254, 898,621 bytes |
| Reference edit | `8dcde191-3084-4bb8-9c82-54595b56e402` | Same robot with a purple hat; PNG, 1254×1254, 946,544 bytes |

The edit transmitted the original managed bytes. Its reference SHA-256 equals
`2a20f93835c57013a16af88119ac88e959cb6c85cd7c1842c6aed6aa111958b6`, the stored original
hash. The edited result hash is
`6c535dabc0478ecfe902a7dbb6759d603417de2663cb1f46e99c95f4f936c376`. The original file
remained unchanged. Actual image dimensions were decoded from the returned PNGs;
ima2's history reports the nominal `1024x1024` request size, which is not a byte-level
dimension guarantee on this route.

The real Lina Codex adapter, image tools, attachment store, native notice journal,
HTTP preview and existing web renderer handled the results. The conversation RPC
was a deterministic test driver, so this proves the image integration path, not a
real conversation model's autonomous tool selection. External image requests were
real and constrained before dispatch to the approved provider/model, exact prompts,
one image per request and two requests total. No extra generation or provider
fallback occurred.

Both images were observed in the same originating test conversation. Restarting
Lina restored the same session, two attachment hashes and exactly two completion
notices. After the first upstream terminal snapshot expired, the adapter also
recovered its completed result from the exact request-filtered history without
resubmission. Subsequent browser reload and a 390px mobile viewport displayed the
saved images. Browser proof waits for image decoding and painting, not only network
completion; the unrelated task sidebar was stubbed empty because this isolated
harness has no fleet API. The test app was stopped and its artifacts retained.

Failure, cancellation and uncertain-request negatives remain covered by local
fixtures. No extra paid call was made to induce those failures. Other providers,
models, mask/video/batch operations, and production deployment remain unqualified.
The local qualification receipt and original/edited image files are retained in
`.codexclaw/evidence/image-engine-live-20260907/` (gitignored).
