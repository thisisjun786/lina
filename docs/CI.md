# CI operation and activation

[POLICY.md](../POLICY.md) owns the rules. This page maps those rules to commands
and GitHub settings. Keep verification evidence with the corresponding PR or
release record.

## Checks

| Check | Command / role |
| --- | --- |
| `changes` | `bun test ./scripts/ci`, `bun run ci:validate`, `bash scripts/ci/secrets.sh`, `bun scripts/ci/plan.ts` |
| `lint` | `bun run lint` |
| `types` | `bun run typecheck` |
| `tests` | `bun scripts/ci/audit.ts`, `bun test ./packages` |
| `build` | `bun run ci:build` |
| `dev-gate`, `release-gate` | `bun scripts/ci/gate.ts` with prerequisite results |

The [workflow](../.github/workflows/ci.yml) checks all PR bases, including
intermediate branches. It runs on new commits, reopen and edits (needed when the
base is retargeted). Editing a title/body also triggers CI with this event choice.
There is no duplicate push or scheduled full suite.

Application jobs are siblings after selection. CI controls run without project
dependency installation; each selected job gets its own frozen install. Package
tests also require Poppler, Python and `prlimit`: the hosted Ubuntu job installs
`poppler-utils` and verifies the three executable versions before the suite.
These system tools are not installed for unrelated lint, type or build jobs. Package
tests already cover adapter contracts, installer failure/pointer behavior and
SQLite persistence. The build invokes the same asset builder the server uses
and checks the CLI outside the checkout with an isolated environment.

`dev-gate` accepts the documented prose-only skips. `release-gate` requires all
source checks and a same-repository `dev -> main` candidate. Neither checks
external provider success nor automatically deploys or publishes anything.

## Secret and dependency checks

`changes` downloads Gitleaks 8.30.1, verifies its SHA256, and scans all available
Git history including merge-parent diffs. The scanner uses the Git database path
from a temporary directory, an explicit reviewed configuration, and an empty
ignore file. Inline allow comments and a repository `.gitleaksignore` do not
suppress findings. The sole exception is the exact RFC6455 public nonce in its
WebSocket handshake test. Scanner configuration and workflow changes still need
maintainer review; PR-owned checks are not an immutable trust boundary.

`tests` runs `scripts/ci/audit.ts`: Bun audits the lockfile, then a separate
inventory reads installed package manifests, including nested bundled packages and
Bun's local store. Package names and versions are sent to the
[npm bulk advisory endpoint](https://docs.npmjs.com/cli/v11/commands/npm-audit/#bulk-advisory-endpoint).
Missing installs, unreadable metadata, network/response errors and any returned
advisory fail the check. No advisory ignore list or minimum-severity exclusion is
used. Run this in a clean checkout: stale, unused Bun store entries can otherwise
still contain old versions and cause a conservative failure. Do not suppress those
findings; reproduce from a fresh frozen install.

The Codex-only source no longer depends on Senpi or needs bundled-package
replacement hooks. Keep installation reproducible from the lockfile with lifecycle
scripts disabled. Installed-manifest scanning does not analyze arbitrary inlined
JavaScript or prove live exploitability.

## Activation

`dev` is the default branch and the target for normal contributions. `main` has
not been created; it is reserved for a future owner-authorized release promotion.
Public source activation does not include creating `main` or promoting a release.

Keep the following protection settings in place and verify them from GitHub
after any settings or visibility change:

| Setting | `dev` | `main` |
| --- | --- | --- |
| Protection mechanism | Classic branch protection | Active ruleset targeting `refs/heads/main` |
| Required check | `dev-gate` | `release-gate` |
| Check producer | GitHub Actions, app ID `15368` | GitHub Actions, app ID `15368` |
| Up-to-date base and PR required | Yes | Yes |
| Required approving reviews | 0 | 0 |
| Resolved conversations | Required | Required |
| Bypass | Admin enforcement; no bypass | Zero bypass actors |
| Force pushes and branch deletion | Blocked | Blocked |

The ruleset for future `main` is active even while the branch is absent. Its strict
`release-gate` requirement also applies when creating the branch; there is no
first-branch exemption or bypass procedure.

Merge commits are the only enabled merge method. Squash/rebase merging, automatic
merge and required linear history are off. Actions use a read-only default token
and cannot create or approve pull requests. Bind required checks to GitHub Actions
so a matching name from another producer cannot satisfy protection.

Verify hosted checks against the actual PR candidate; checked-in workflows and
local results do not establish a hosted result. Public activation also requires
reporter-visible access to the private route in [SECURITY.md](../SECURITY.md), as
described in [publication guidance](PUBLICATION.md). Administrators with settings
access can change the rules themselves; the protections are not immutable.

Before any merge, re-read the PR head/base, required checks, draft status,
mergeability and unresolved conversations. Match the reviewed head when invoking
the merge action (`gh pr merge --merge --match-head-commit <SHA>` is one option).
Strict status checks cover target-branch movement; an expected-head argument
alone protects only the source branch. Refresh checks when either input changes.
After a future authorized promotion, reconcile the new `main` merge commit into
`dev` through a PR before the next promotion; do not use a direct push to
synchronize branches.

## Failures and changes to CI

Inspect the failing job's logs; do not replace a failed or cancelled result with
success. Selector and aggregator tests cover missing/malformed results, unexpected
skips and branch/diff edge cases. For CI changes run their tests and inspect the
workflow wiring together; pure function tests do not prove that GitHub ran a job.

GitHub executes PR-owned workflow code. A hostile edit could weaken these scripts;
review changes to `.github/` and `scripts/ci/` as changes to the checks themselves.
Pinned Actions and read-only hosted jobs reduce privilege exposure but do not
make the PR's own result unforgeable. Repository settings remain the merge barrier.

Revert a broken CI change through a reviewed corrective PR; do not remove the
required gate or bypass protection to obtain a green badge. If rollback cannot
satisfy the current gate, record the blocker and have the owner explicitly decide
the recovery scope. Do not create an undocumented bypass.

## Contributor client guidance

Keep repository policy in this checkout. Client preferences do not activate
server-side protections or establish an independent review.

Portable **commit instructions**:

```text
Follow the current repository's POLICY.md, AGENTS.md, and commit conventions.
Describe the actual change and its reason concisely. Add verification or
compatibility details only when useful. Do not invent tests or outcomes, include
secrets, or treat these writing instructions as permission to commit or push.
```

Portable **pull request instructions**:

```text
Follow the current repository's POLICY.md and pull request template. Choose the
base branch from that repository's policy. Explain the problem and resulting
behavior, the checks actually run, and material risks or unverified work. Include
UI evidence when relevant. Keep release promotion, publishing and deployment
within their separately authorized scope. Do not invent issue links or test results.
```

Leave global automatic-merge instructions empty while automatic merge is off.
Keep branch names, required checks and release authority in each repository's
policy rather than hardcoding Lina rules into every project's global prompt.

## References

- [GitHub rulesets and strict checks](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/available-rules-for-rulesets)
- [GitHub pull_request event](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#pull_request)
- [OpenAI desktop developer settings](https://learn.chatgpt.com/docs/developer-settings)
