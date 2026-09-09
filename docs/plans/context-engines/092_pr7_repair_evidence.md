# PR7 repair evidence

This records the completed local repair phase. Subsequent delivery authorization permits committing these repairs, pushing PR7 and checking hosted CI; merge and deployment remain excluded. The local-only statements below describe the earlier verification snapshot.

Five local repairs and their independent reviews are complete. This is not a merge approval; the final source-bound check receipt is the delivery gate.

## Artifact and authority

Baseline HEAD: `ed5064911f084a24f228244d6a3bb6fdda7ab4b9`. Target: `dev@cd74c89ea642735a9eeee9f63f88651b900a7bef`. Repeated read-only GitHub queries found unchanged head/base, draft/open and mergeable. Hosted run `34331963073` remains green for the baseline; it does not cover these uncommitted repairs.

Local branch: `codex/pr7-verification-fixes`, workspace `/home/jun/.codex/worktrees/4498/lina`. The original PR branch and detached baseline worktree are preserved. No commits, pushes, PR comments, merges, deployments, real-user data writes or external model calls occurred. All runtime data and servers used synthetic temporary state and loopback ports.

Original adversarial report: `/home/jun/tmp/lina-pr7-review-01a08577/REPORT.md`. Repair diagnostics and logs: `/home/jun/tmp/lina-pr7-fixes-01a08577/`.

## Repaired behavior

| Original severity | Owner | Failure and repair | Reproduction evidence |
| --- | --- | --- | --- |
| P1 | `packages/lina-codex/src/session.ts` | Reopening advertised compacted original IDs as resident, suppressing fresh-tail injection. Reset residency after native replay and before a compaction request. Newly delivered originals still deduplicate in the current attachment. No new journal format or migration. | `compaction-red.log`, checked-in context-policy tests, original real SessionApp replay `compaction-app-green.log`, separate Bun writer/reader processes `compaction-process.log`. Reader reports no historical resident IDs. |
| P2 | `packages/lina-memory/src/engine/store.ts` | Reconfirming identical conclusions incremented generation and retracted children. Compare semantic content and sorted premise IDs/content hashes; retain generation and children while refreshing changed sources/proofs/support through existing durable receipts. Evidence fences still precede either no-op or update. | Initial red, additional metadata-refresh red, `memory/metadata-green.log`: 27 pass; `memory/final-suite.log`: 162 pass. Original runtime repro retains `park.visits` through three turns and empty induction. |
| P2 | `packages/lina-runtime/src/fleet/resource-runtime.ts` | Each tool call lost its search cursor. Retain up to 64 task consumers, scoped by task/persona/revision; unattributed calls use their signal identity and shared scope. AsyncLocalStorage supplies each call's current authority without overwriting overlapping calls. Abort/eviction/close remove cached sessions. | Original cursor red/green plus `cursor/negatives.log`: 4 pass, covering next page, foreign scope/revision, cancellation, changed visibility and overlapping guards. |
| P2 | fleet publication/image routes and `images/life-posts.ts` | One post resolved the entire feed and repeatedly loaded all image attempts. Derive principal-visible requested IDs, resolve only those IDs and reuse one attempts snapshot. Keep post/recipient authority, exactly-one-attempt, artifact and file-byte checks. | `images/red.log`: 9-post fixture, one GET, 10 full attempt loads. `images/green.log`: 1 full load; original 16-assertion image test unchanged and passing. `images/negatives.log`: 41 pass. |
| P2 | `packages/lina-memory/src/resources/indexing.ts` | Document sources reloaded/decoded the catalog per document. Documents return their own reference; collection traversal shares the writer transaction's catalog snapshot. Historical visibility, membership and job identity stay unchanged. | `index/red.log`: 7 pass/2 fail; green 9 pass; resource suites 75 pass. Main constant-blob scale at 50/100/150 documents: 3.8/6.8/10.7ms versus baseline 30.0/115.4/246.6ms. Operation counts, not latency SLA, are the acceptance evidence. |

## Independent review and corrections

Plan audit found two missing explicit caller scopes and a missing compaction/epoch-transition negative; amended plan passed. Separate implementation owners handled memory/indexing; main took over stalled image/cursor work after stopping those agents.

Compaction review rejected relying solely on persisted compaction markers: missed notifications cannot prove native residency. Main replaced the marker design with conservative replay handling. A later alleged same-epoch rebind defect was challenged against control flow; reviewer retracted it and returned PASS. Image review returned PASS after checking core provenance enforcement and the unchanged asset validation.

Memory review reproduced stale source metadata in the initial no-op design. Main added a failing source-refresh test and separated generation preservation from metadata refresh. Merely requiring metadata equality and using the old update path would recreate child invalidation, so that proposed shortcut was not adopted. Premise-order equivalence also has a regression test. Final metadata review: PASS, including independent repeated refresh/reopen and controlled-clock mood expiry probes. Cursor review: PASS, including the real task manager call path. Its noted concurrency-test gap was closed by asserting the error inside search itself, before the final response guard.

## Evidence layers and limits

- Local synthetic: temporary real SQLite stores, actual App/Fleet routes and loopback HTTP, fixed model outputs. Original counterexamples were replayed by main against repaired imports.
- Actual subprocess: separate Bun adapter restart; checkpoint SIGKILL/WAL recovery; native-enabled Codex package with installed Codex CLI 0.153.4 and local synthetic provider. Final native Codex run: 270 pass, 0 fail, 1371 assertions. Runtime native qualification: all 6 optional tests passed, 193 assertions, covering the remaining standard-suite skips.
- Hosted CI: baseline only, 3500 pass/47 skip/0 fail. New local code has no hosted CI result.
- External provider: none. Model quality, live API/model compatibility, deployment, browser UI and production load were not qualified.
- Reopening may re-inject bounded fresh-tail originals already present in native context; this conservative cost avoids omitting originals without residency proof.
- Collection-heavy graphs still require per-collection traversal; this repair removes repeated catalog loading and document quadratic work, not every graph-growth cost.
- Image metadata still verifies requested file bytes. The 30-second image test budget is unchanged and is not evidence of performance improvement or proof against every possible hang.
- The temporary nine-post diagnostic inherited a final one-post expectation from its single-post source fixture; after the main bug was fixed, that unreachable stale assertion was corrected to exactly nine. The original checked-in 16 assertions were preserved.
- Prior ambiguous historical-conversation resource retention was not changed. The review covers the specified high-risk boundaries; it is not exhaustive proof of all 929 changed files.

## Verification ledger

Initial root/browser typecheck, lint after formatting, CI validation, web asset/isolated CLI build and 184 CI-control tests passed. One whole-package run overlapped the new metadata regression and caught the old loaded implementation (3515 pass/47 skip/1 fail); it is not counted as final green evidence. The completed metadata fix passed all 162 memory tests and nine connection/reproduction tests. A subsequent whole-package run passed 3516 tests / 47 skips / 0 failures (19855 assertions), but its receipt was correctly refused because a duplicate field in a new test was corrected during execution. That refused receipt is not used. Final source is fixed before the source-bound receipt command below.

Existing-owner searches included nativeHistoryFloor/nativeEntryIds/journal/header, sameValue/contentHash/applyConclusions, ResourceSearch/consumer/TaskToolContext, feedImages/imageAttempts/publicationPost and sources/allResources/changed. Existing persistence, consumer, route, asset and index owners were extended; no dependency, framework or new public endpoint was introduced.

## Merge decision

Do not merge current GitHub PR7: its head still contains the original defects. After local repairs are independently verified, applying them to the PR and running its required hosted dev-gate remain outside this session's authorization. No merge or release is certified by this local repair loop.


## Final delivery checks

- Full package command: `bun test packages` (3516 pass, 47 standard native-opt-in skips, 0 fail in the completed pre-receipt run).
- Every standard-suite native skip was separately exercised: 41 Codex cases plus 6 runtime cases, all passing against the installed local engine and synthetic providers.
- Root/browser TypeScript, Biome, CI-control tests (184 pass), workflow/form validation, web assets and isolated CLI build are local evidence. No hosted repair result exists.
- Final command and log: `/home/jun/tmp/lina-pr7-fixes-01a08577/final-check.py` and `final-check.log`.
- Source-bound receipt: `.codexclaw/evidence/01a08577-4fee-7913-a696-9683fb73221e/test-receipt.json`. The receipt tool runs the final commands and refuses source changes during execution.
- The final script rechecks typecheck, lint, CI validation/build, all package tests and CI-control tests against the fixed tree. No assertion, skip, retry policy or timeout was weakened. Existing 16 image assertions and the 30-second budget are unchanged.
- No task-owned server is intentionally retained. Diagnostic files and baseline/fix worktrees are retained for review. Reviewer probe files were moved from `/tmp` into the repair evidence directory.

Remaining limits: no external model quality/compatibility qualification, deployment or browser UI proof; bounded search sessions can evict cursors; deep memory provenance refresh is per reasoning round; collection-dominated graphs still incur traversal cost. These are not claims of newly demonstrated cross-owner leakage or additional merge blockers in the local repair.

## Resource dispatch repair after engine-state verification

The next re0 lap reproduced two dispatch omissions on329b6cb through actual
loopback Fleet HTTP: retry returned pending without queueing the resource, and
child mutations created collection overview jobs without queueing the affected
collections. Both probes failed after awaiting the production queue drain;
explicit scheduling advanced them to the expected unavailable state with the
model unconfigured. No external provider calls were made.

Retry now notifies the existing execution owner after the validated transition.
Operation receipts persist newly created indexing-job resource IDs in an optional
result field, preserving reads of legacy receipts. A store-owned WeakMap exposes
those effects for both fresh and replayed results; HTTP and tools forward the
exact results, including deletion. The
Fleet filters affected resources with the initiating scope and coalesces queued
work per agent/resource. A mutation during execution can queue a subsequent pass.
The changed resource is queued before its collections so extraction precedes
collection processing. Existing completed source digests remain reusable.

The original HTTP probes pass after repair. Regression coverage includes nested
and secondary collections, moves, deletion with a surviving child, queued
coalescing, in-flight follow-up scheduling, inaccessible effects, and replay
after reopening the catalog. Local diagnostics and red/green logs are
under `/home/jun/tmp/lina-pr7-dispatch-fix-01a08577`; the original negative corpus
is under `/home/jun/tmp/lina-pr7-re0-engine-01a08577`.

This repair does not claim to resolve the separately measured collection-heavy
catalog scan cost, provider quality, or process-crash delivery of in-memory queued
work. It adds no timer, provider fallback, test skip, or timeout extension.
