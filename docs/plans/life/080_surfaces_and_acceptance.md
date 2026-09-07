# 080 — Product surfaces, operation and complete acceptance

Status: proposed. Depends on 010–070 and the UI-owner renderer changes. Scope: deliver the whole user journey and demonstrate actual behavior. Does not authorize deployment or paid calls from this plan alone.

## Changes and field path

| Operation / exact path | Before → after |
| --- | --- |
| NEW `packages/lina-web/client/life-api.ts`, `life-model.ts`, `life-view.ts`, `life-authoring.ts`, `life-profile.ts`, `life.css` | No LIFE client → world creation/editing, timeline/thread, agent profile/history and visible operational states |
| MODIFY client `conversation-app.ts`, `navigation.ts`, `intro-model.ts`, `index.html`, `styles.css`, `agents.ts` | Add ordinary-app LIFE entry and deep links while preserving agent-first navigation, first introduction and draft recovery |
| MODIFY `packages/lina-web/src/life-proxy.ts`, runtime `fleet/life-routes.ts`, `fleet/server.ts` | Complete authenticated draft/run/feed/interaction/asset/profile endpoints; revision and idempotency handling |
| MODIFY runtime `life/config.ts`, `scheduler.ts`; NEW `life/health.ts` | Configurable lifecycle, bounded queues/usage, recoverable failure status and safe diagnostics |
| MODIFY runtime `checkpoint-barrier.ts`, `checkpoint-cli.ts`; history `src/inventory.ts`, `manifest.ts`, `restore.ts` only if existing generic coverage is insufficient | Existing offline checkpoint gains explicit LIFE/world/image lease coverage and restore validation; reuse history ownership |
| NEW web `test/life-model.test.ts`, `life-navigation.test.ts`; runtime `test/life-e2e.test.ts`; NEW `scripts/qa/life-engine.ts`, `scripts/qa/life-browser.ts` | Integration fixture, browser driver and separately enabled provider acceptance runner |
| MODIFY runtime `test/checkpoint-barrier.test.ts`, `checkpoint-cli.test.ts`; history `test/checkpoint.test.ts` | Include LIFE data/assets, reject an active writer, restore and reopen all owner stores |
| MODIFY `docs/PLANNING.md`, `CODEX_RUNTIME.md`, `VALIDATION.md`, platform 009–013 and `packages/lina-web/DESIGN.md` if new surface rules are needed | Planned capability → exactly evidenced capability, remaining limitations and recovery instructions |

File names target the current vanilla TypeScript client, not an invented React app. UI owner may move composition points; map old/new paths before building instead of editing a stale parallel renderer. Keep existing semantic tokens and Codex visual direction. No new concept art is needed for this plan; scene images are product content delivered by 070, not a visual-style redesign.

New URL state originates in authenticated navigation/actions; serializes world/agent/post IDs and non-sensitive view state; parses known variants on boot/popstate; feeds `life-model.ts`, API requests and rendered views. Never put secrets, task logs or provider credentials in URLs/local storage. Server responses include revision/cursor and permitted fields only. Unknown view kinds route to a safe recoverable error, never ordinary onboarding. Test request schemas and browser deserialization as well as core types.

## Interaction contract

| Surface | User path and state meaning |
| --- | --- |
| Start LIFE | Optional ordinary-app entry → write background → review generated draft/missing decisions → confirm world version → preview a step or configure running. First user introduction remains separate. |
| World settings | Edit confirmed background/constraints with before/after preview; advanced rules under a details panel. Conflicts explain the changed revision. Pause/resume and selected operating policy remain visible. |
| Timeline | Read permitted posts, images and threads; switch world/agent without losing position. Quiet world is an honest empty state, not fake seeded posts. |
| Post/thread | Reply, configured reactions and reshare with audience preview. Pending acknowledgment is distinct from posted; retry keeps the same request ID. No mutation on render or background refresh. |
| Agent profile | Current persona and public growth/relations, published experiences and avatar history. World-author private inspection is a distinct mode. Pin/restore acts on avatar revision without overwriting persona. |
| Image states | Awaiting image, generating, uncertain, failed import and completed are distinct. User can reconcile/cancel/retry where supported; don't claim cancellation refunded usage. |
| Running states | Not configured / paused / running / waiting for model / usage exhausted / needs attention. Each offers one relevant next action. Technical diagnostics live behind details, not inside routine feed cards. |

Web/PWA and Electron share the renderer. LIFE adds a destination without replacing the agent list or turning the sidebar into a session list. Mobile uses existing full-screen navigation; back restores world/post/scroll/draft. Use semantic buttons and keyboard focus, readable labels and image alt text derived from permitted material. Preserve dark/light/system tokens, text zoom, reduced motion and screen reader state announcements. Do not force a user to configure simulation to continue normal conversations/work.

## Runtime operations and persistence

One fleet-owned LIFE service opens isolated world/job roots under configured Lina state, not repository fixtures or another task's live data. Shutdown stops admission, cancels local waits, fences pending commits and records uncertain external operations; it does not claim remote cancellation succeeded. Reopen audits schema/history/checkpoints and reconciles outbox/image/publication receipts before admitting new work. A corrupt world is quarantined from simulation while other worlds and normal chat remain usable; show an actionable export/restore path without overwriting evidence.

Provide exports/backups for world definitions, accepted log, social checkpoints, inputs/receipts and referenced assets. Record a consistent snapshot boundary; do not copy live WAL files independently and call it a backup. Restore checks versions, owner binding, hashes and referenced assets. Deleting/resetting a world is an explicit user action, not an automatic test recovery strategy. Quotas must preserve idempotency tombstones and audit references. Disabled/archived worlds stop scheduling and retain readable authorized history.

Reuse `lina-history` and the existing offline `checkpoint-cli.ts`/`checkpoint-barrier.ts` path. LIFE and fleet image writers must participate in its installation/owner leases; absent participation is a failed checkpoint acceptance case. Existing state-root inventory may already cover the files: verify that before changing its manifest. Record any external provider history/shared Codex/remote-memory gaps explicitly. Restoring to a new isolated destination and opening every owner store is the proof, not merely a successful copy. No new parallel backup framework or automatic external export is part of this phase.

Diagnostics record step/intent IDs, durations, selected model/engine/rules versions, usage reserved/reconciled/unknown, queue depth, rejected proposals, dedupe hits, blocked disclosure and public error codes. Never log raw secrets/provider request bodies by default. Operational proof can inspect isolated test payloads. Model/image failure does not take down ordinary work; backpressure and queue caps prevent LIFE from consuming all runtime capacity.

## Acceptance layers

| Layer | Execute and observe | What it does not prove |
| --- | --- | --- |
| Deterministic integration | Temporary real SQLite/files, fixture models and fake image transport; task source→event→growth→post→reaction→next step; crash at each commit/delivery boundary | Actual model decisions, provider behavior or interesting content |
| Codex/model contract | Capture real serialized request and tool list for each actor/director/narrator and next ordinary turn; assert knowledge/purpose separation and persona anchors | Whether an actual model follows the intended character over time |
| Actual model | Explicit configured route and run budget; at least one complete causal story plus unseen contrasts with secrets/goals/failed work. Retain request/result evidence and compare future responses | Statistical guarantees across all models/worlds or absence of every inference |
| Actual image | Generate an event picture and reference-based follow-up where supported; import verified bytes, display correct post, restart; avatar slot/pin/restore. Qualify multi-character identity separately | Identity consistency from a catalog row or successful HTTP status |
| Browser | Drive creation→draft confirmation→run/quiet→feed→reply→profile→image→pause→reload on real web renderer; observe screenshots and state changes, desktop/mobile, keyboard | Engine causality if only static mock cards were shown |
| Recovery/operation | Kill/reopen isolated processes at named boundaries; config changes, quota, unavailable model, corrupt DB, backup/restore and stale workers | Deployment/installed-user data safety without a separate rollout |

New QA scripts are **planned, not currently executable commands**. `life-engine.ts` must default to isolated fixtures/no provider, require explicit live mode plus model/image selection and usage cap for actual calls, emit machine-readable evidence and fail on missing invariants. `life-browser.ts` consumes the isolated server handle/URL and records actions/screenshots. No sleeps to await signals; capture real completion events. Keep evidence out of product source and omit credentials/private content. Record the exact implementation revision and tool/runtime versions beside results.

## Quality and stop criteria

Hard requirements: zero duplicate logical events/growth/post/avatar application in the tested crash matrix; zero unauthorized private text/IDs in captured model/API/image inputs; no loss of accepted history; authored anchors and explicit user changes preserved. Contrasts must demonstrate at least one personality-dependent choice, asymmetric relationship update, work-dependent opportunity, belief correction, intentional permitted secret reveal, and user-reply-dependent future action. A no-op “growth stored” result is a failure.

Narrative review uses withheld scenarios, not the actor's own self-grade. Record reviewer/user judgments with examples for character distinction, continuity, plausible consequences, non-repetition and image relevance/recognizability. Keep story quality separate from transport invariants. Do not set an invented engagement-score target or claim psychological validity of trait axes. Persistent failure of these contrasts means revise actor/rules/memory selection, not merely add more random events or posts.

Completion requires the whole story in 000 plus distinct model/image/browser/recovery evidence. If paid runs remain unapproved or the image contract cannot support consistent multi-character scenes, report the exact unverified capability; do not downgrade the original requirement silently. UI/image owners implement their surfaces, LIFE owns contract/integration acceptance. Feature flags cannot substitute for demonstrated activation.

## Validation and handoff rules

Before each implementation phase, check current `AGENTS.md`, `POLICY.md`, base revision and actual owner interfaces. Start changed behavior with failing tests. Once focused checks pass, run the repository-required type/lint/build/regression gates for the actual diff. The root typecheck currently includes `packages/*/src`, `packages/*/test`, `packages/*/scripts`, `scripts/*.ts`, `scripts/ci/**/*.ts`; it does **not** include new `scripts/qa/*.ts`. Add an explicit strict QA typecheck or extend the reviewed config and prove it reads these scripts.

Stage rollout separately: isolated test state → user-configured manual LIFE → explicitly configured recurring simulation/publication/images. No live-state migration, merge, deployment or provider spend follows automatically from a passing fixture. Publish verification limitations with the feature. User controls can bypass their own publication/pause settings intentionally; client controls are convenience, the server/store policy is the final application layer (E7), and a compromised host remains outside that boundary.
