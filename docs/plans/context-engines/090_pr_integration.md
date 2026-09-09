# Unified LIFE and context-engine review candidate

PR #3 and PR #6 share a LIFE baseline but have diverged. This single integration
unit preserves their commit histories and produces one ordinary PR to `dev` for
the owner's later detailed feature review. Source branches remain available.

## Loop contract

- Archetype: satisfy-spec, one PABCD work-phase (`wp1`), C3 integration with
  storage/recovery checks receiving C4 care.
- Trigger/goal: Jun requested consolidating #3 and #6 into one PR before a separate
  detailed review.
- Scope: merge the pinned heads, resolve only integration conflicts, verify and
  publish a new PR; close #3/#6 only after the replacement exists with passing CI.
- Non-goals: new features, broad refactoring, full feature/security acceptance,
  merge to `dev`/`main`, native stacks, branch deletion, release/deploy, installed
  data changes, external model calls or messages to independent tasks.
- Verifiers: ancestor checks and merge-resolution diff; existing LIFE/session,
  storage isolation, persona and image tests; native synthetic Codex qualification;
  root typecheck/lint, CI validation/build; hosted `dev-gate` on the current PR.
- Stop: replacement PR published, original heads and current `dev` contained,
  required checks pass, old PRs closed, tracked worktree clean.
- Evidence: this document and task-local `.codexclaw/evidence/` receipts/logs.
- Outcomes: DONE satisfies all criteria; NOOP requires live existing consolidation;
  unresolved checks or conflicts are reported without claiming completion.
- Escalation: source-head drift requires reconciliation before publication;
  irreversible operations outside the stated scope require owner direction.
- Resources: existing agent allocation, local toolchain and repository-scoped GitHub
  credentials; synthetic temporary state only. No user token or wall-clock cap was
  supplied, and none is invented. Commands use bounded managed execution.

## Anchors and preservation

- #3: `cefaffcbb4d767848ace6bc0151b9271bf336bf2` (`codex/world-engine`).
- #6: `d75a11f6a617f9de02cd1246ae27d87d94c4cce7` (`codex/context-engines`).
- Remote `dev`: `cd74c89ea642735a9eeee9f63f88651b900a7bef`.
- Common ancestor: `0b68b2f40b8f4368a78111ad1228626886a43797`.
- Worktree: existing app-managed checkout, new `codex/integrate-life-context` branch
  starting at #6. No source branch/worktree is moved or rewritten.

Git merge-tree reports three conflicts when combining #3 and #6. Compared directly
to #3, #6 retains LIFE recovery and adds personal growth in the installation owner,
publication v3 assertions in the end-to-end test, and owned-memory lifecycle tests
in the session test. The existing code is reused; no new runtime abstraction is
planned. Both original commits must be ancestors of the delivered merge commit.
The merge commit must have #6 and #3 as its two parents; current `dev` is already
contained by #3 and is brought into the candidate by that parent.

## Change map

| Path | Integration decision |
| --- | --- |
| `packages/lina-runtime/src/fleet/life-runtime-installation.ts` | Keep #6's personal-growth declaration; #3's side of the conflict is empty and its recovery code is already ported. |
| `packages/lina-runtime/test/life-e2e.test.ts` | Preserve the causal LIFE/image/restart scenario and #6 publication v3 lane/profile assertions. |
| `packages/lina-runtime/test/session-app.test.ts` | Preserve #3 image tools and #6 native-memory retirement, learning-policy and restart assertions. |
| Other automatically merged files | Inspect the actual merge delta against #6; reject duplicate ported code, accidental resurrection of retired Honcho adapters or deletion of either feature. |
| `packages/lina-web/scripts/qa-image-engine.ts` | Retain #3's synthetic image QA entry point; its fixture/assets/server consumers match both heads and root typecheck includes package scripts. |
| `docs/LIFE_ENGINE.md`, `docs/plans/life/081_serialization_performance.md` | Retain #3 consumer/recovery and serialization evidence documents. |
| This integration record | Record actual resolution, evidence and consolidated PR handoff; keep existing detailed acceptance limitations. |

No new field, enum, schema or enforcement layer is planned. Creation/serialization/
deserialization/consumer changes are therefore N/A; existing cross-package contracts
must survive the merge. The primary source-of-truth documents remain
`docs/LIFE_ENGINE.md`, `docs/ARCHITECTURE.md` and the existing context acceptance docs;
correct any integration-created contradiction without rewriting prior evidence.

## Verification and decision boundaries

The main agent resolves the three coupled files locally. A read-only independent
reviewer first audits this plan, then a fresh reviewer checks only the integration
delta and lost-contract risk. Neither performs the deferred full feature review.
No implementation is delegated; the conflict edits are tightly coupled and small.

Existing script definitions in `package.json` point typecheck to root/browser
tsconfigs, lint to the repository, and CI validation/build to `scripts/ci`.
These candidate checks had not run when the plan was written; their completed
results are recorded below.
Dependencies are installed locally from `bun.lock` with lifecycle scripts disabled.

1. Run `git merge-base --is-ancestor` for each pinned source and current remote dev;
   inspect all merge-only changes and conflict-marker absence. Merge-tree was run:
   exit 1, exactly three conflict paths listed above.
2. Run existing focused tests for session initialization/image registration, LIFE
   causal post/replay, rejected LIFE storage preserving ordinary conversations,
   publication storage access, and ordinary persona growth. Explicit file arguments
   make these checks observe the resolved owner and its consumers.
   The direct paths are `packages/lina-runtime/test/session-app.test.ts`,
   `life-e2e.test.ts`, `life-storage-isolation.test.ts`,
   `life-publication-storage-access.test.ts` and `persona-native-growth.test.ts`
   in that test directory. Runtime/test equivalence to #6 is a separate Git check;
   these tests requalify the preserved source rather than prove new behavior.
3. Run `LINA_LIFE_NATIVE_TEST=1 LINA_AUTHOR_NATIVE_TEST=1 bun test packages/lina-codex`;
   these existing tests use native subprocesses with synthetic providers. No live
   account call is permitted. Run the remaining full package suite through hosted CI.
4. Run `bun run typecheck`, `bun run lint`, `bun run ci:validate`, `bun run ci:build`.
   Do not weaken assertions, add skips, increase timeouts or suppress checks to pass.
   If integration causes a real failure, retain the failing evidence before repairing.
5. Re-read live source heads and base, publish the consolidated PR with both source
   links and current evidence, wait for hosted `dev-gate`, then close #3/#6 without
   deleting branches. No `dev` merge is authorized.

Conditional activation evidence is supplied by existing storage-corruption,
ownership, memory-disabled/retired, image registration and restart scenarios.
Passing source checks do not certify installed-data rollout or narrative quality.

## Result

Integration merge `6970941` has #6 `d75a11f` and #3 `cefaffc` as its exact parents.
Both source heads and pinned remote `dev` pass ancestor checks. All three conflict
files retain the audited #6 contents. Every runtime source and test blob equals
#6; the added synthetic image QA script equals #3. The remaining merge delta is
the restored LIFE/image documentation and existing image QA screenshots.

Fresh local checks on this combined source:

- Focused session/LIFE/storage/persona regressions: 23 passed, zero failed,
  141 assertions across five files. The four-file pre-merge baseline passed
  19 tests and 123 assertions.
- Native-enabled Codex tests: 268 passed, zero failed, 1,361 assertions across
  45 files, using real local subprocesses with synthetic providers.
- Root/browser typecheck, lint, CI validation and runtime asset/CLI build smoke
  passed. Lint retains 26 existing warnings; no automated fixes were applied.
- Independent plan audit passed with no blockers. Its non-blocking documentation
  clarifications are incorporated above. The separate integration review and
  current hosted CI outcome are recorded on the consolidated PR.

This unit establishes one preserved integration candidate. It does not complete
the owner's deferred detailed feature review, installed-data rollout, live-model
qualification or renderer acceptance. Historical acceptance records keep their
original source and evidence boundaries.
