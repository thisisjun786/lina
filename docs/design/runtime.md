# Runtime

This contract fixes what LINA's components are built from and how they run: the language and the one runtime, the vendored source, the LINA kit, the conversation loop and its model path, the non-chat adapters, the tools and their sandbox, the tools LINA uses without owning them, storage, packaging, updates, recovery, remote access and the composition of LINA OS. It is normative: implementations must follow it, and any change to it goes through a pull request against this file. Finishing this document does not mean any component is built or accepted; runtime proof belongs to the implementation issues that consume it.

## Scope

In this document, Node is LINA's device execution component and Node.js is the JavaScript runtime. The two names are never interchangeable.

This contract covers:

- the language, the runtime and the processes of every component LINA builds
- the vendored pi loop core and the LINA kit
- the conversation loop, the model path through opencodex and the non-chat adapters
- the conversation tools, plugin tools and the OS sandbox
- installed tools that LINA uses without owning them, including worker agents
- storage engines, packaging, the release manifest and the device-Node exception
- updates, recovery, failure injections, remote access and LINA OS composition

It does not cover the envelope and wire formats ([host-protocol.md](host-protocol.md)), grants, epochs, receipts and the approval policy ([main-authority.md](main-authority.md)), turn preparation, request assembly, persona, memory and compaction ([conversation-and-memory.md](conversation-and-memory.md)), the work engine, the kind-of-work rule, worker adapters and the LINA work harness rules ([work-and-delegation.md](work-and-delegation.md)), plugins ([integrations.md](integrations.md)), installation modes and LINA OS profiles ([product-families.md](product-families.md)), the state root, backup generations and restore ([filesystem.md](filesystem.md)), screens ([surfaces.md](surfaces.md)) or dependency and vendoring rules ([dependencies.md](../policy/dependencies.md)).

## Language and runtime

LINA Core, `moirai-worker`, the `lina` TUI, the worker adapters and Node are TypeScript and run on one Node.js runtime. The LINA work harness is TypeScript too and runs inside the worker agent ([work-and-delegation.md](work-and-delegation.md)). The LIFE world engine is part of the LINA Core family and is TypeScript on the same runtime; its packaging is a backlog item ([cognition-and-life.md](cognition-and-life.md)). Bun is not used.

The conversation engine stands on the [pi](https://github.com/earendil-works/pi) agent loop and the [Codex](https://github.com/openai/codex) tool contracts. LINA vendors pi because it is a TypeScript library inside LINA's own engine and is inherited, not translated. An upstream change reaches LINA as a diff, never as a new translation.

Development runs TypeScript sources directly. Node.js strips types when it loads a file, so no build step sits between an edit and a test run; LINA's code therefore uses only TypeScript syntax that type stripping can erase. Type checking uses the native TypeScript compiler (TypeScript 7) in strict mode. Because AI agents write most of LINA's code, the time from an edit to a type-checked test result is a measured property of the stack (V7).

Each function has exactly one path. A function never switches to a second transport when the first one fails. A missing piece makes its function unsupported, and the function says so.

External components (document parsers, OCR, the local transcription component and similar) may be written in any language, need any runtime and carry any license, Python, a JRE and AGPL code included. They run only as separate processes at a version pinned by the release, and are never linked or loaded into a LINA process.

## Installed tools

LINA uses some tools that the user installs and that LINA neither ships nor pins: coding agents such as Codex for workers ([work-and-delegation.md](work-and-delegation.md)), the command-line tools that plugins rely on, such as `gh`, and the local server commands of third-party plugins ([integrations.md](integrations.md)). Each is a separate project with its own releases and repository.

- LINA uses the installed tool found on `PATH` or at a path the user configured, and records the version it observed.
- LINA lists the versions of each such tool that it has verified. A version not on the list is reported to the user as unverified, with the version found and the verified versions, and LINA still uses the tool. A function becomes unsupported only when its tool is missing, can't be started or connected to, or fails its protocol handshake, and LINA says why.
- LINA never installs, updates or pins the tool on its own. Inside the user's Codex, the only thing LINA installs and updates is its own work harness plugin ([work-and-delegation.md](work-and-delegation.md)).
- LINA OS may offer to install these tools for the user ([product-families.md](product-families.md)).
- A sibling product the user installed, such as RUMI, connects only through the declarations of [host-protocol.md](host-protocol.md), which refuse an unlisted combination.

## Processes

| Process | Built from | Runs as | Needed for |
| --- | --- | --- | --- |
| LINA Core | TypeScript on the bundled Node.js runtime | A service under the user's own OS user | Everything; it is the only canon writer |
| `moirai-worker` | TypeScript on the bundled Node.js runtime | An optional background service of the LINA Core install | Background memory and planning |
| `lina` TUI | TypeScript on pi-tui, on the bundled Node.js runtime | A user process connected to LINA Core over its local socket or the tailnet | The terminal surface ([surfaces.md](surfaces.md)) |
| Node | TypeScript on the bundled Node.js runtime, subject to the device-Node exception | A service on each device | Device execution under grants |
| Worker agent | The coding agent the user installed, with the user's own configuration; Codex runs as `codex app-server` | A stdio child of LINA Core, or of Node on a remote device | Workers |
| LINA work harness (`lina-work`) | LINA's own TypeScript, shipped in LINA releases as a Codex plugin | Inside the user's Codex, where LINA installs it at the first delegation | Delegated work |
| Sandboxed commands | Whatever a tool call runs | Children of LINA Core inside the OS sandbox | Shell and file tools |
| Plugin processes | Local MCP server commands of installed plugins, and the command-line tools that plugins rely on when LINA Core runs them for its own reads | Children of LINA Core under the user's OS user, outside the command sandbox, with the environment of sandboxed commands | Plugins ([integrations.md](integrations.md)) |
| External components | Any language, pinned by the release | Separate processes | Parsing, OCR, local transcription |
| opencodex | The upstream npm package [`@bitkyc08/opencodex`](https://github.com/lidge-jun/opencodex) (MIT), pinned by the release | A local service installed with LINA, which LINA connects to | Every chat model call |
| Sibling processes (RUMI) | Their own repositories and releases | Their own processes with their own state | Nothing in LINA; LINA reads their records as sibling records |

LINA Core never calls a sibling's API at run time, and never starts, stops or restarts opencodex or a sibling process on its own. The operating system's service manager runs them as their own services.

## Vendored source

LINA vendors one upstream source together with its tests, pinned to one upstream commit. How vendored code is kept unchanged, wrapped, patched, pinned and synced is defined in [dependencies.md](../policy/dependencies.md); the source commit, files and license notices are listed in [THIRD-PARTY-NOTICES.md](../../THIRD-PARTY-NOTICES.md).

### pi loop core

The conversation loop is the agent loop core of pi (MIT): `agent-loop.ts`, `agent.ts`, `types.ts` and `stream-fn.ts` from `packages/agent/src`, with their tests. The loop imports message types, tool argument validation and its event stream from `pi-ai`; those files enter the vendored scope as part of the import closure. `pi-ai`'s providers and every provider SDK stay out. LINA supplies the stream function on openai-node (see Model path).

## LINA kit

The LINA kit is the stateless public TypeScript module that LINA Core and RUMI share. It holds:

- the Responses adapter: openai-node with `store=false`, the encrypted reasoning round trip and the stream assembly rules of this document
- the loop: the vendored pi loop core
- the tool executor and the sandbox wrapper
- document parsing, passage anchors and citation checks
- the sibling protocol types, generated from the JSON Schema in [host-protocol.md](host-protocol.md)

The kit never holds a default state path, a persona, skills or a database writer. Callers pass state locations, persona and skills explicitly, and each product stores its own records. What differs per host (writer fencing, queues, the layer that owns retries) stays in each product. The kit has its own version, separate from product and protocol versions.

The kit ships only as source in LINA release tags. It is never published to the npm registry. A sibling takes the kit by vendoring it as source from one LINA release tag, under the same vendoring rules as any upstream source ([dependencies.md](../policy/dependencies.md)), and records the kit version and the LINA release tag in its release manifest.

## Conversation loop

The conversation engine is LINA's own loop inside LINA Core, built on the vendored pi loop core through the kit. The Codex app-server never runs a conversation, and a Codex home never holds conversation state. Apart from installing its work harness plugin, LINA only reads the user's Codex home: for discovery ([work-and-delegation.md](work-and-delegation.md)) and as external evidence ([conversation-and-memory.md](conversation-and-memory.md)).

The loop behaves as follows:

- The inner loop runs tool calls and input that arrives while a turn runs (steering). The outer loop runs follow-up input after a turn ends.
- Tool calls of one response run in parallel, and their results return in the original call order. Argument validation and pre-tool checks run in order, before any call starts.
- A tool call in a response cut off by the output limit is never executed. The loop returns a result that asks the model to call again with complete arguments.
- On abort, every open tool call receives an `aborted` result, so the recorded history stays valid for the next request.

Retries and failover have one owner: LINA Core. The vendored loop and the SDK never retry on their own.

The conversation ledger, turn preparation (including the executable hash and opencodex readiness checks), request assembly, persona injection, compaction and resume are defined in [conversation-and-memory.md](conversation-and-memory.md).

## Model path

Every model call of LINA's own engines goes through opencodex, the local Responses API proxy. opencodex is a LINA dependency: LINA's installation installs the upstream opencodex package at the version the release pins, and the pin follows upstream releases under [dependencies.md](../policy/dependencies.md). LINA connects to its local Responses endpoint. The only exceptions are the non-chat adapters. There is no fallback to direct provider authentication.

### Requests

LINA Core calls the Responses API of opencodex at `http://127.0.0.1:10100/v1` directly with [openai-node](https://github.com/openai/openai-node) at a pinned version, through a thin adapter between LINA's types and the SDK's types.

- `store` is `false`. Every request carries the full input it needs.
- With reasoning on, the request includes `reasoning.encrypted_content`. Every reasoning item, tool call and tool output since the last user message goes back in the next request unchanged, as the [reasoning guide](https://developers.openai.com/api/docs/guides/reasoning) requires.
- `previous_response_id`, `store: true`, server-side compaction and WebSocket mode are never used.
- The request fields LINA sends form a list in the release manifest. A new field enters the list before it is sent.
- Auxiliary reasoning (internal inference without tools) is a separate request with no tool list and no persona. It runs as its own run kind, can cause no external effect, and its output is never recorded as part of the conversation.

### Stream assembly

LINA assembles the server-sent event stream itself:

- Text and argument deltas accumulate per output item. Deltas drive live display only.
- An output item is final only at `response.output_item.done`. The recorded item, and the item sent back in the next request, is the done item. Encrypted reasoning is taken from `response.output_item.done`, never from `response.output_item.added`, whose value may be incomplete.
- Tool calls are dispatched from final items only.
- `response.completed` closes a response. It is never evidence that a product effect happened.

### Failures and retries

- SDK automatic retries are 0, and the value is recorded in the release manifest.
- Once output has started, a request is never sent again. An accepted turn is never replayed automatically; a turn whose outcome is unknown stays unknown.
- Failures are typed from the response itself: proxy unavailable (`/readyz` 503 or a failed connection), authentication expired, and quota or combination unavailable (429, 503).
- LINA Core reads the request ID header, the error type and `usage` from every response and records them in the ledger.

### Models and the management plane

- The conversation model list comes from the opencodex catalog, and LINA Core records the catalog revision. The catalog is for display and is never capability evidence.
- Model and effort are fixed at request boundaries: per conversation request, at worker thread creation and at the next turn boundary. A running request or an active turn never switches model or effort.
- LINA never changes the model on its own. A model switch is an explicit decision and takes effect from the next request.
- Ownership of provider accounts, sign-in and model enablement is defined in [product-families.md](product-families.md). LINA Core reads the opencodex management plane read-only and never exposes it to LINA APP or to any remote client.
- A worker agent reaches models through its own configuration ([work-and-delegation.md](work-and-delegation.md)).

### Usage and cost

- Usage comes from `usage` in each conversation response and from the usage events a worker agent reports, such as Codex's `thread/tokenUsage/updated`. An unreported value is unknown, never zero.
- The total budget covers conversation requests, worker threads, sub-agents inside workers and auxiliary reasoning. Selector cost and the number of reselections are capped.
- The actual model, routing reason and cost per request come from the opencodex management plane (`/api/usage`, `/api/logs`), read by LINA Core. The management token lives in LINA's secret store ([filesystem.md](filesystem.md)) and is read only by LINA Core; it never reaches LINA APP, a remote client or a worker. When the plane can't be read, route and cost are unknown.
- Budget totals count tokens. Catalog prices and zero values are not actual cost.
- LINA Core reserves and settles the budget. At the limit the conversation stops sending requests, and workers are interrupted under the budget policy of [work-and-delegation.md](work-and-delegation.md). The Codex goal token budget is not used.
- A conversation request is matched to its opencodex record by the request ID header. A worker's model, route and cost are known only as far as its agent reports them.

### Request regression

A regression test compares LINA's requests with a baseline: the request that Codex sends through opencodex for the same conversation, with the Codex version recorded alongside the baseline. It compares fields, `include`, the reasoning resend and the built-in tool declarations. It runs again whenever the opencodex or SDK pin, or the baseline, moves.

## Non-chat adapters

The Jev judge, embedding and transcription each have their own adapter outside opencodex. Their keys, billing and failure diagnosis are separate from opencodex, and none of them appears in the chat model list, the catalog or automatic routing. Jev is called only through its own typed adapter.

None of them blocks basic conversation:

- When embedding is off or failing, recall keeps working at lower quality, as defined in [conversation-and-memory.md](conversation-and-memory.md).
- Transcription defaults to a local transcription component pinned in the release, which needs no key and no setting. An external transcription API is optional, and the transcription adapter is that optional path. With no transcription at all, only recording-to-meeting-notes is unsupported.
- When Jev is off or has no key, rules and the main model produce the same function ([cognition-and-life.md](cognition-and-life.md)).

Each adapter reports its connection state, key presence and usage to settings. An adapter that is off reports its state and is never required at first run.

## Tools and sandbox

### Tool set

The conversation engine's tools are the same kind as a Codex worker's, declared with Codex's names and formats: shell execution (`exec_command`, `write_stdin`), file editing (`apply_patch`), `view_image`, `update_plan`, a question tool and a permission request. LINA adds its own tools: reading materials and memory, the memory tools (write, correct and forget, defined in [conversation-and-memory.md](conversation-and-memory.md)), dispatching work, reading plans and querying its own events ([self-diagnosis-log.md](self-diagnosis-log.md)).

Plugin tools are the tools of the plugins that are on ([integrations.md](integrations.md)). Each is named `<plugin>__<tool>`, at most 64 characters, and plugin tools are declared in a deterministic order. When there are many, the conversation declares a subset and loads the rest on demand. The release manifest lists the built-in tools. Plugin tools come from the user's installed plugins, so the conversation ledger records the hash of the plugin tool declarations sent with each request.

Tools are declared in `tools` on every request, and a change to the tool list applies from the next request. `apply_patch` is a custom tool; opencodex converts its format for the backend. LINA's `apply_patch` accepts the Codex patch grammar, and the grammar's test fixtures from Codex (Apache-2.0) run as regression tests with their notice kept.

Conversation and work are split by the kind of work, not by tools. The routing rule is in [work-and-delegation.md](work-and-delegation.md).

### Execution rules

- Before a tool runs, LINA Core checks the user, scope, grant, target, revision and current epoch ([main-authority.md](main-authority.md)).
- Every tool has a deadline and always returns a result. A failure before the effect starts returns the failure and its reason. When the deadline passes while the effect runs, or its outcome can't be known, the tool returns "outcome unknown, do not retry" and the effect ledger records `unknown`. Effect states are defined in [host-protocol.md](host-protocol.md).
- The effect ledger deduplicates tool effects by the idempotency key defined in [host-protocol.md](host-protocol.md), never by call ID. The same effect called again with a new call ID never runs twice; the call returns the first result, or `unknown`. The record and key of a plugin write are defined in [integrations.md](integrations.md).
- An effect outside the grant, and every plugin tool call, follows the approval policy of [main-authority.md](main-authority.md), including its tiers for plugin tools and the rule for when no surface can present an approval request.

### Default scope

- The conversation working directory is `workspace/` under the state root ([filesystem.md](filesystem.md)).
- The user files LINA reads by default are the library scope: the set of connected sources ([filesystem.md](filesystem.md)). Nothing enters it unless the person connects it.
- The default grant, before any approval, is write access in the working directory and read access in the library scope.

### Sandbox

Shell and file tools run inside an OS sandbox that LINA Core invokes directly through the kit's sandbox wrapper. Shell and file tools never run unsandboxed. Plugin processes run outside it (see Processes) and are controlled at the tool call ([main-authority.md](main-authority.md)).

- The write roots are the conversation working directory and the grant's scope. Everything else is read-only, and `.git` directories inside a write root stay read-only.
- Network is blocked by default. A sandboxed command gets network access in one of two ways:
  - A command that an installed plugin's service profile classifies, such as `gh` or `git` under the GitHub plugin, gets it when LINA Core approves its elevation at that command's tier ([integrations.md](integrations.md), [main-authority.md](main-authority.md)). This classification is the default for those commands.
  - Any other command gets it when the model asks for network for that command and the person confirms, as in Codex. The first request asks, with the choices once, always allow and deny. "Always allow" records a standing grant for commands with the same prefix, which the person revokes in settings at any time ([main-authority.md](main-authority.md), [surfaces.md](surfaces.md)).
- Sandboxed commands get LINA Core's environment without model-provider keys, so the user's own tools and settings, including the GitHub setup of [integrations.md](integrations.md), work there as they do for the user. LINA's secret store, the opencodex management token and data keys are never visible inside the sandbox.
- The policies follow the Codex sandbox source (Apache-2.0), with provenance recorded. The active sandbox policy is recorded in the release manifest.

On Linux the sandbox is [bubblewrap](https://github.com/containers/bubblewrap) with seccomp. bubblewrap runs as a separate executable and is never linked. Commands get their own user and PID namespaces, their own network namespace while network is blocked, and `no_new_privs`. The seccomp filter is a compiled BPF program shipped with the release for each architecture and handed to bubblewrap by file descriptor.

On macOS the sandbox is Seatbelt: `/usr/bin/sandbox-exec` with an SBPL profile derived from the Codex profiles. Apple marks `sandbox-exec` deprecated and offers no command-line replacement, so LINA checks that it works on every start.

On Windows the conversation engine's shell and file tools run only inside a verified Windows sandbox. A verified Windows sandbox is part of Windows Node acceptance; until it passes, those tools report unsupported on Windows instead of running unsandboxed.

LINA Core checks on start, and before the first tool call, that the sandbox works on this host. Unprivileged user namespaces, AppArmor restrictions and hardened kernels can each disable bubblewrap. When the sandbox is missing or fails, conversation continues, only shell and file tools are unsupported, and the user sees why.

## Workers

Workers are coding agents the user installed, driven through one worker adapter per agent; Codex is the first, through its app-server protocol over stdio. LINA uses the installed agent as it is (see Installed tools): its version, login, model provider, sandbox, approval mode, plugins and integrations are the user's own configuration. The LINA work harness is LINA's own rebuild of the CXC coding-work harness; it ships in LINA releases as a Codex plugin that LINA installs and updates in the user's Codex ([work-and-delegation.md](work-and-delegation.md)).

The adapter boundary, the Codex adapter, compatibility, readiness, assignment, approvals, the harness rules and merges are defined in [work-and-delegation.md](work-and-delegation.md).

## Storage

- Structured state lives in SQLite through `node:sqlite` ([Node.js SQLite](https://nodejs.org/api/sqlite.html)), the SQLite built into the bundled runtime. No other database engine or SQLite binding is used.
- Vector search uses [sqlite-vec](https://github.com/asg017/sqlite-vec) at a pinned version, loaded as an extension of `node:sqlite`. Its platform binary is verified against the digest in the release manifest before it loads.
- Canon databases run in WAL mode. Full-text search uses SQLite's FTS5. How recall uses FTS5 and sqlite-vec is defined in [conversation-and-memory.md](conversation-and-memory.md).
- Vector indexes are derived data, rebuilt from canonical text. Moving the sqlite-vec pin rebuilds the indexes and never touches canon.
- Backups use SQLite's online backup, never a copy of database or WAL files. What a backup generation holds is defined in [filesystem.md](filesystem.md).

## Packaging

### Bundled Node.js runtime

LINA OS and every desktop install ship a verified Node.js runtime with the release. Verified means the official Node.js release archive, checked against the project's signed checksum list ([verifying binaries](https://github.com/nodejs/node#verifying-binaries)), with its version and digest in the release manifest. LINA components start on that runtime by absolute path. A system Node.js, a version manager or `node` on `PATH` is never used. A runtime update is a LINA release and is applied as described in Updates.

Supported platforms are defined in [product-families.md](product-families.md). A platform and architecture enter the supported-combination table of [host-protocol.md](host-protocol.md) only after the packaging and resident measurement passes on them.

### Services

- LINA Core is a systemd service running as the user's own OS user, so it sees the user's tools and settings the way the user's own Codex does.
- `moirai-worker` is an optional systemd user service of the same OS user.
- Node registers with the device's service manager: systemd on Linux, launchd on macOS and a Windows service on Windows.
- An install never restarts an existing service without authorization. New settings, databases, services, ports and paths never overwrite existing ones.

### Install compositions

Installation modes are defined in [product-families.md](product-families.md). Each mode is one of these runtime compositions:

| Composition | Contains |
| --- | --- |
| Conversation only (general Linux) | LINA Core, the TUI, opencodex, optionally `moirai-worker`, and bubblewrap |
| Minimal general Linux | Conversation only, plus the worker adapters, which drive a coding agent the user installed when work is delegated |
| LINA OS main | Minimal general Linux, plus Node, LINA APP and exactly one update owner |
| Additional device Node | Node. Coding work there uses the coding agent installed on that device, and is supported only after transfer between that device and the main is verified. |
| LINA APP only | LINA APP |
| Development host | Not a product composition |

When a piece is missing:

- Missing conversation pieces make conversation fail its readiness checks. There is no `PATH` fallback.
- A worker agent that is missing, can't be connected to or fails its handshake, or a LINA work harness that LINA can't install, makes only delegation unsupported. An unverified agent version is reported and never stops delegation.
- A missing `moirai-worker` makes only background memory and planning unsupported.
- A running service is never evidence that a turn succeeded.

### Release manifest

The release manifest records:

- external components, each with version, digest, execution mode, source and license
- versions and digests of LINA Core, Node, LINA APP and `moirai-worker`
- the bundled Node.js runtime and sqlite-vec, with versions and digests
- the LINA kit version
- the conversation SDK version and its retry values
- the request field list
- the built-in conversation tool declarations and the sandbox policy
- the LINA work harness: its revision, content hash, hook declaration and contract version
- the verified versions of the installed tools LINA uses (see Installed tools)
- the process environment rules for sandboxed commands and plugin processes
- the service configuration
- the state schema version
- the supported-combination table ([host-protocol.md](host-protocol.md))
- opencodex: its version, digest and address format

The manifest pins only LINA's own artifacts and dependencies: its components, the bundled Node.js runtime, opencodex and the external components LINA ships. A change to a pinned value (opencodex, harness, SDK, request field list, environment rules, retry values) lands in the same pull request as its manifest change.

### Device-Node exception

Node is TypeScript on the bundled Node.js runtime like every other component. If Node fails the packaging or resident budget set by measurement, only Node moves to a compiled language, behind the `node` connection of [host-protocol.md](host-protocol.md). LINA Core and every other component stay TypeScript. The protocol is the boundary, so the move changes no canon, no grant rule and no LINA Core code.

The budget covers artifact size, start time, and resident memory and CPU over 24 hours, measured with OS instrumentation. It is declared before the measurement runs and recorded with the result.

## Supply chain

Every external dependency, vendored source and bundled binary follows [dependencies.md](../policy/dependencies.md). Its gates run in CI from the first commit ([ci.md](../policy/ci.md)).

## Updates

LINA OS composes pinned artifacts. Replacing the OS and migrating or rolling back state schemas are separate operations.

An update runs in this order:

1. Drain: settle in-flight effects and record any whose outcome is unknown.
2. Snapshot the ledger, the schemas and the manifest.
3. Prepare the new composition: new binaries and settings, with the previous ones kept for rollback.
4. Smoke: one conversation request with its readiness checks, and the worker readiness check when a worker agent is installed.
5. Resume.

Rollback restores the previous compatible composition from the kept binaries and the pre-update snapshot. Binaries are never rolled back over an irreversible migration. When an update fails, the install restores the previous compatible composition, or holds: it stops, keeps the current state intact and reports. It never leaves a half-updated component running against data it can't read. LINA OS adds steps of its own around this order (see Deferred).

- opencodex is updated only as part of a LINA update, by its pin. An update never starts, stops or updates a tool the user installed, such as a worker agent or RUMI.
- A hash of a dirty work tree is never a release.
- An Omarchy update is never a ready receipt for LINA's composition. Snapshot settings, a CLI version or an active service never prove an install composition, a restore or model readiness.

## Recovery

LINA Core dispatches nothing before its new epoch is durable ([main-authority.md](main-authority.md)). On restart, LINA Core stops pending approvals, tool calls and background effects and fences the previous process generation: a late response from that generation never changes current state. An effect that couldn't be stopped is recorded as unknown and is never re-run automatically. Worker turns cut by the restart follow [work-and-delegation.md](work-and-delegation.md).

Restore, its order and its compatibility rules are defined with backup generations in [filesystem.md](filesystem.md).

## Failure injections

Before a composition is accepted, each of these failures is injected and the outcome must match the rule it tests.

These install and update failures must end in the previous compatible composition, or in a hold that keeps state intact and reports:

- a truncated download
- a start failure after install
- a full disk during install or update
- a path change of the installation or data location
- a backup that doesn't form a compatible pair with the installed version
- a process killed between update steps

These runtime failures must end as their rules require:

| Injection | Required outcome |
| --- | --- |
| Digest mismatch of the bundled runtime or sqlite-vec | The component doesn't start and reports the mismatch |
| Sandbox unavailable | Conversation continues; shell and file tools are unsupported and the reason is shown |
| opencodex unavailable | No request is sent; the TUI shows the typed cause |
| LINA Core killed with a tool call in flight | The effect is unknown and never re-run; a late result from the old generation is fenced |

## Remote access

Remote access uses [Tailscale](https://tailscale.com/kb) only. LINA APP, the TUI and Node connect to LINA Core directly inside the tailnet. Tailscale owns device identity and access control. LINA has no login of its own and registers a device on its first connection. LINA Core accepts remote connections only on its tailnet address; there is no relay and no public listener. A relay and a login of LINA's own are on the backlog ([cognition-and-life.md](cognition-and-life.md)).

## LINA OS composition

LINA OS is Linux based on [Omarchy](https://github.com/basecamp/omarchy). It composes verified LINA Core, Node and LINA APP artifacts, pinned by manifest with version and digest, together with the bundled Node.js runtime and an operating, update and recovery environment. LINA components on LINA OS never run on a distribution-provided Node.js. Its profiles are defined in [product-families.md](product-families.md).

- opencodex is part of LINA's installation on LINA OS, as on every install.
- LINA OS may offer to install a coding agent such as Codex, and RUMI, for the user. They are the user's installed tools (see Installed tools); LINA OS neither pins nor owns them. How RUMI runs there is defined in [product-families.md](product-families.md).
- An Omarchy root snapshot or an Omarchy update is never a restore or a readiness proof for LINA Core. The recovery units of LINA OS are defined in [filesystem.md](filesystem.md).

LINA APP's form on Omarchy is chosen in [surfaces.md](surfaces.md).

## Runtime acceptance

The first implementation issue demonstrates the runtime with these checks. Each check's baseline comes from outside LINA: requests sent by Codex, tests written upstream, the installed Codex and OS instrumentation.

| Check | What runs | Passes when |
| --- | --- | --- |
| V1 opencodex pass-through | openai-node through opencodex for three or more turns with `store=false`, the encrypted reasoning round trip, a custom tool (`apply_patch`) and parallel tool calls | Every turn round-trips without rejection, and the fields match the Codex baseline request |
| V2 packaging, storage and residency | The bundled Node.js runtime, `node:sqlite` with sqlite-vec (WAL, FTS5 and vector queries), registered with systemd on Omarchy x64 and launchd on macOS arm64, for 24 hours | The extension loads, the services start, and size, start time and resident memory and CPU stay within the declared budget on both platforms |
| V3 pi loop vendoring | The vendored loop core with its upstream tests, with the stream function on openai-node | The loop tests pass and the build pulls in no provider SDK |
| V4 LINA work harness | The LINA work harness, installed by LINA as a plugin in the user's Codex, on an assignment from LINA Core | A stage receipt and a completion receipt reach LINA Core through LINA's work tools, and the Stop hook round-trips |
| V5 worker adapter round trip | Types generated with `generate-ts --experimental` from the installed Codex, then `initialize`, `thread/start` with `dynamicTools`, `item/tool/call` and turn completion | The round trip completes with the installed Codex, and the adapter records its version |
| V6 supply-chain baseline | The gates of [dependencies.md](../policy/dependencies.md) on the minimal dependency set, with the lockfile and transitive package count recorded | The gates pass and no dependency needs a lifecycle script |
| V7 development loop | On the Phase 1 tree, an agent's edit to one package followed by strict type checking of the affected packages and their tests, and the full `foundation` run | The time from the edit to the test result, and the `foundation` time, stay within the declared budget |

## Deferred

- The packaging and resident budget for LINA Core and Node: set by the first implementation issue's packaging and 24-hour resident measurement (V2).
- The development loop budget: declared before V7 runs.
- The compiled language for Node, should the device-Node exception apply: chosen when that measurement shows Node fails the budget.
- The Windows sandbox mechanism for shell and file tools: chosen and verified by the Windows Node implementation, which cannot be accepted without it.
- Exact pins (Node.js runtime, openai-node, sqlite-vec, opencodex, the pi commit): set by the first implementation issue and recorded in the release manifest.
- The verified versions of each installed tool: set by the first implementation issue (V5 for Codex) and recorded in the release manifest.
- Whether LINA Core as a service sees the user's login environment (`PATH`, the SSH agent and the keychain), or reads the login shell's environment once at start instead: measured by the first implementation issue.
- Per-tool deadlines, the selector cost cap and the reselection limit: set during implementation acceptance of the conversation engine.
- Absolute install locations, the absolute state root, service names and socket paths per OS: set during packaging implementation acceptance.
- LINA OS's own update steps (a pre-update snapshot check and an extra backup before drain): set during LINA OS implementation acceptance.
