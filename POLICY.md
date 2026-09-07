# Lina development policy

Lina is maintained by one owner with agent assistance. Prefer small, coherent
changes, short feedback loops and deliberate releases.

This repository owns its development, CI and merge policy. This file is the
authority; [AGENTS.md](AGENTS.md) holds implementation contracts and
[CONTRIBUTING.md](CONTRIBUTING.md) explains contribution steps. Upstream projects
are references, not inherited policy. Lina OS has its own repository and lifecycle.

**Activation:** checked-in workflows define the checks below. They do not activate
GitHub branch protection. Follow [CI activation](docs/CI.md#activation) and record
actual GitHub results before claiming that merge restrictions are enforced.

## Branches and merge authority

| Target | Purpose | Required check | Merge method |
| --- | --- | --- | --- |
| `dev` | Integrate completed changes | `dev-gate` | Merge commit |
| `main` | Promote the repository's `dev` branch | `release-gate` | Merge commit |

Work in short-lived branches such as `codex/ci-merge-policy`, preferably in an
isolated linked worktree. Normal PRs target `dev`. Intermediate dependent PRs
receive development CI too; they do not authorize promotion to `main`.

Merge only when the PR is ready, its current candidate has the required green
gate, it is up to date with the target, GitHub reports no conflicts, review
conversations are resolved, and no confirmed material defect remains. Read the
current head and base immediately before merging and use an expected-head guard.
If either changed since verification, refresh the candidate and its checks.
Never use a direct protected-branch push, force push or protection bypass.

Required human review count is zero. Automated reviews are advisory with no
mandatory waiting period; confirmed defects still need resolution. An agent may
complete a `dev` merge within the user's authorized delivery scope. A review-only
request, merge hold, or local-files-only task remains a limit. Do not ask again
for an action already authorized.

Every `dev -> main` promotion requires explicit owner instruction for that
promotion and user-facing release notes. CI accepts only a same-repository `dev`
head for `main`; there is no alternate hotfix bypass in this initial policy.
Send urgent fixes through `dev` and the same release gate. A green gate or merge
does not authorize tags, publishing, deployment, paid provider calls or changes
to installed user data.

## Verification and cost

The graph is `changes -> independent checks -> result-only gate`.

| Job | Coverage |
| --- | --- |
| `changes` | CI-control tests, workflow/form validation, contribution links, complete-history secret scan, complete PR diff and selection |
| `lint` | Existing Biome check |
| `types` | Strict root and browser TypeScript checks, including CI scripts |
| `tests` | Dependency vulnerability audit and all package tests, including persistence, installer and adapter contracts |
| `build` | Actual runtime web-asset build and read-only CLI smoke outside the checkout |
| `dev-gate` / `release-gate` | Validate prerequisites and report one stable required result |

Development skips application jobs only for an explicit prose allowlist.
Runtime prompts under `data/` are application input even when they are Markdown.
Mixed, unknown, empty or shared configuration diffs select all application jobs.
Unreadable Git history or malformed selection fails; it never means docs-only.
Deleted files and both sides of renames contribute to selection. See
[the executable selector](scripts/ci/plan.ts) for the allowlist.

Main promotions always run every source check. Each job tests GitHub's combined
merge candidate, not just the author's branch. Gates run even after failures,
require successful selection and selected jobs, and reject missing, failed,
cancelled or malformed results. Skips are valid only for deliberately excluded
application checks. Gate jobs do not install the application or rerun tests.

Use the smallest meaningful local checks during development. A duplicate full
local suite is not mandatory before opening a PR. For CI changes, exercise
selection and aggregation negatives as well as the normal path. Tests await
signals; retries or longer sleeps do not repair nondeterminism.

Use hosted Linux runners, pinned Bun and Action revisions, bounded timeouts,
read-only tokens and independent job state. Cancel obsolete runs of the same PR.
No duplicate push suite, test shards, merge queue, or broad OS matrix is needed
without evidence of a bottleneck or a supported-platform requirement. Cache
downloads only when measured setup cost warrants it, never test verdicts.

Use `pull_request`, not privileged execution of PR code in `pull_request_target`.
Do not give PR jobs production credentials, user data, local services or
self-hosted runners. Install from the committed lockfile with lifecycle scripts
disabled. New install hooks or privileged CI surfaces require a deliberate policy
change, not a convenience workaround.

Secret scanning uses a pinned, checksum-verified Gitleaks release and explicit
configuration. Scan all available Git history, including merge diffs. Ignore
inline allow comments and repository ignore files; a reviewed exception must
identify an exact synthetic value and its exact test path. Do not baseline away
unreviewed findings. The dependency audit checks both the lockfile and installed package versions,
including nested bundles, and must pass without suppressing known advisories. Consumer overrides require a specific compatibility justification. These checks do not certify live exploitability or the
absence of every possible secret. Workflow and scanner configuration changes
remain subject to maintainer review.

## Dependencies and compatibility

Codex is the sole supported execution engine. Senpi execution, legacy transcript
import and OmO job execution are retired; existing data is preserved.

Lina owns its consumer contracts. An upstream green build does not prove Lina
still works. Dependency PRs record old/new versions, the upstream change, affected
interfaces and tests. Keep lockfiles committed; update versions in focused PRs.
Do not automatically update running services or blindly follow upstream `main`.

- **Codex and OpenCodex:** external execution/proxy services as well as Lina-owned
  adapters. Record the actual tested engine/service versions separately from the
  npm lockfile, plus provider, API, model and affected capability.
- **OpenViking/Honcho:** optional external memory adapters; validate their consumer
  contracts without production memory in CI.
- **CXC/paperthin:** development tools; contributor skill installations are not
  required dependencies of ordinary CI.

Required CI uses local fakes and synthetic temporary data. Live compatibility
qualification needs a separate authorized run and evidence for the exact
engine × API × model combination. A catalog response, HTTP 200 or health check
does not establish successful tool use, persistence or restart recovery.

Source gates do not certify container deployment, native macOS/Windows behavior,
model quality or a public release. A release promising those capabilities must
attach the corresponding artifact, platform or live evidence. Report gaps; do
not quietly weaken a failed check to make a release pass.

## Issues, PRs and preservation

Use the short bug, feature, compatibility or decision forms where useful.
An issue is not required for every fix. PRs explain the problem and result,
verification, and material risks; include UI evidence when the interface changes.
Release PRs additionally record release notes, gate evidence and owner approval.
Templates guide authors; prose quality is not enforced by keyword bots.

Keep credentials, private conversations, production memory and user workspaces
out of issues, logs and commits. Redact requests before sharing them upstream.
Preserve existing dirty work. Do not reset, clean, stash, rebase or delete another
task's branches/worktrees. Report local changes, CI, merge, release and deployment
as distinct states.
