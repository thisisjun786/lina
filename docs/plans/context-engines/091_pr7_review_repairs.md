# PR7 adversarial review repairs

Baseline: `ed5064911f084a24f228244d6a3bb6fdda7ab4b9`; dev base `cd74c89ea642735a9eeee9f63f88651b900a7bef`.
Original review and executable counterexamples: `/home/jun/tmp/lina-pr7-review-01a08577/REPORT.md` and adjacent diagnostics.

## Scope and authority

One repair phase, five disjoint tasks. Deliver local uncommitted product fixes and regression tests. No commits, pushes, PR comments, merge, deployment, real-user data writes or external model calls. No timeout extension, retries, skips or weakened assertions. No time/token budget specified.

Existing owners and tests are reused. Configuration cannot repair lost residency state, invalidated reasoning generations or cursor lifetime; repeated catalog/image enumeration needs narrower existing queries. No new framework or dependency. Historical conversation resource retention remains outside scope because retroactive erasure is not the current contract.

## Implementation and completion criteria

| Task | Write scope | Failing regression and acceptance |
| --- | --- | --- |
| t1 main | lina-codex session residency, persistence owner and related tests | Reopen after compaction must not advertise pre-compaction originals as resident; retain newly delivered same-attachment entries, handle repeated compaction, compact-then-context-transition-then-reopen, and old journals conservatively. Reopen conservatively after native history replay; a journal marker cannot prove disconnected compaction absence. Reset before compaction requests. Test actual process restart with synthetic RPC where feasible, distinguish from real provider proof. |
| t2 executor | lina-memory engine reasoning store and reasoning tests | Identical eligible conclusion reconfirmation must retain generation and descendants; changed value, premises, eligibility and revocation must still invalidate. Exercise runtime empty induction counterexample as well as store tests. |
| t3 executor | lina-runtime fleet resource-runtime, resources/services.ts and resources/search.ts if needed, and task resource tests | Search then next-page through separate executeTool calls succeeds; authority is checked live per call. Cursor must not cross caller/task scope, outlive cancellation or retain stale assertCurrent closures. Reuse search ownership; retain bounded cursor eviction. |
| t4 executor | lina-runtime fleet life-images, life-publication-routes, life-routes.ts, images/life-posts.ts snapshot contract and tests | One post or page must not resolve the entire feed. Use one shared attempt snapshot for the requested posts; preserve withdrawal, grant/recipient revocation, file integrity and authority. Assert operation counts with many posts; preserve original 16 image assertions and timeout. |
| t5 executor | lina-memory resources indexing and indexing tests | Updating a document does not repeatedly scan/decode all resources for every document. Reuse one catalog view when collections require it; preserve membership, stale jobs, version/visibility invalidation and revocation. Assert scan counts, compare original scale fixture without absolute timing SLA. |

Each executor reads target and direct callers, records existing-owner searches, adds a failing test before product changes, and reports exact commands/results and touched paths. No edits outside its write scope without main coordination. Main owns plan/FSM, t1 and combined integration. All stores, ports and sessions use isolated temporary state.

## Review and final verification

Independent plan audit precedes implementation. Main inspects each returned diff and replays the original counterexample against repaired code. Independent final review challenges the combined diff and negatives; resolve blockers before completion.

Run relevant memory/resources/runtime/Codex suites, native Codex subprocess tests with synthetic provider, root and browser typecheck, lint, build and CI contract validation. Reuse unchanged baseline hosted CI only as historical evidence; no hosted result exists for uncommitted repairs. Run broader package checks when the combined changes justify them. Record source-bound test receipt and exact local diff, full failing/passing evidence, subprocess versus synthetic boundaries, and remaining limitations in a numbered evidence document.

DONE requires all five task regressions green, owner/revocation/integrity negatives green, independent review clear, required local checks passing, owned processes cleaned up and honest evidence-layer reporting. This does not authorize merge or certify external-provider behavior.
