# Continuous Integration

The [CI workflow](../../.github/workflows/ci.yml) classifies a change, runs the applicable checks, and reports one required result: `foundation`.

## Execution

```text
selection ----+---- docs -------+---- foundation
              +---- automation-+
```

`selection` records the exact base and candidate commits, changed paths, selected checks, and the selection reason. It also checks Git whitespace errors. `docs` and `automation` run independently after selection. `foundation` only evaluates their results; it never reruns their commands.

| Event | Coverage |
| --- | --- |
| PR into `dev` | Classify the diff from the target base to GitHub's merge candidate. |
| Push to `dev` | Classify the integrated commit against the previous dev head. This produces the exact-commit evidence used for release. |
| Manual dispatch | Run every current check, regardless of changed paths. |
| PR into `main` | Reject the target. A metadata-only job also attempts to close the PR; fork token restrictions may prevent closure. |

New runs cancel obsolete runs for the same PR or branch. Each job has a bounded timeout. Short checks share one job and setup; independent checks run in parallel. Add platforms only for an actual support commitment, not as an empty matrix.

## Change classification

The executable path map is [ci-scope.mjs](../../.github/scripts/ci-scope.mjs).

| Change | Selection |
| --- | --- |
| Only explicitly listed root/PR documents or Markdown directly under `docs/policy/` or `docs/design/` | `docs`; no automation installation or test run. |
| Workflow, issue-template, verification-script, or shared repository configuration | Both checks. |
| Empty or unavailable diff | Both checks; never assume documentation-only. |
| An unmapped path in the changed paths or candidate tree | Both checks, but `foundation` refuses to pass until its verification is registered. |

Deleted paths and both sides of a rename participate. A `.md` suffix alone does not make a file prose: prompts, executable examples, and test inputs need their consumer's checks.

## Current checks

- **docs:** validate local file targets in all tracked Markdown and `LICENSE`, including links from unchanged documents to deleted targets. This does not validate external URLs, heading anchors, or the meaning of prose.
- **automation:** check JavaScript syntax, run the Node behavioral suite, and validate Actions syntax and shell blocks with the pinned actionlint release. Release tests execute the workflow's actual shell steps against disposable Git repositories and explicit GitHub-response fixtures; they never publish real releases. The pinned actionlint archive is cached by version and checksum; every run re-verifies the checksum before extraction.

The scripts use Node 20 or newer and built-in modules. Release fixtures also use Bash, Git, and jq. Action versions and the actionlint checksum live in the workflow.

## Timing and budget

| mode | baseline run | event | cache | wall s | runner s | wall bound s | runner bound s |
| --- | --- | --- | --- | ---: | ---: | ---: | ---: |
| full | 36239758274 | push | miss | 26 | 20 | 50 | 40 |
| docs | 36240717925 | pull_request | not used (automation skipped) | 23 | 13 | 40 | 30 |

The bound is U(x) = 10 * ceil(max(1.5x, x + 15) / 10) seconds, applied to wall and runner seconds; wall is measured from run creation to the last non-skipped job completion of attempt 1, and runner is the sum of non-skipped job durations.

A run above its bound is investigated before the bound is changed; a bound changes only by PR with the new measurement.

## Passing and failing

[ci-gate.mjs](../../.github/scripts/ci-gate.mjs) always runs after the selected jobs. Selection must succeed, every selected job must report `success`, and an unselected job must report `skipped`. Missing, failed, cancelled, malformed, or unexpectedly skipped results fail the gate. Do not use workflow-level path filters that prevent the required result from appearing.

The Actions summary names the candidate, selection reason, and job results. A green `foundation` means the registered checks passed, not that unimplemented product behavior or model quality was established.

## Local verification and extension

```sh
node .github/scripts/check-docs.mjs
node --test .github/scripts/*.test.mjs
actionlint
git diff --check
```

Use the actionlint version pinned in the workflow. During iteration, run the affected test file rather than repeating the entire suite. Pure prose needs reading and link/format checks, not tests pinning its wording.

Introduce a new component together with its real verification commands, path mapping, and gate expectations. Tests must exercise the behavior being changed; bug fixes need a regression that fails without the fix. Build/install checks should use the produced artifact. Share commands between local and CI execution, and avoid running the same suite again in an aggregator. Cache downloads and reproducible build inputs, not previous pass/fail results.

## Go components

Product components are Go packages in the repository's Go modules, built with the toolchain that the `toolchain` line of `go.mod` names. `go build` produces each component's static binary; there is no other build step. The [dependency policy](dependencies.md) governs what the modules may require and defines the `dependencies` check.

### Registration

Register a component in [ci-scope.mjs](../../.github/scripts/ci-scope.mjs) in the PR that adds it. Its entry names:

- its directory, so that every path under it, including Markdown, belongs to the component;
- its packages, which CI verifies with `go build`, `go vet` and `go test`, so local and CI verification use the same commands.

The protocol JSON Schema in `protocol/schema/` and the conformance fixtures in `protocol/fixtures/` are registered with the component that generates types from them, so a schema or fixture change runs type regeneration and the fixtures ([host-protocol.md](../design/host-protocol.md)).

The scope script reads the imports between components from the Go packages, so a change to one component also selects every component that depends on it. Until a component is registered, its paths remain unmapped and `foundation` refuses to pass. Register a vendored tree under `third_party/<name>/` the same way as any other component. `go test` runs its upstream tests unchanged.

### Path mapping

| Change | Selection |
| --- | --- |
| A path under a registered component directory | `components` for that component and its dependents. |
| A path under `third_party/<name>/` | `dependencies`, plus `components` for that tree and its dependents. |
| A `go.mod`, `go.sum` or Go workspace file, or the root `package.json`, `package-lock.json`, `.npmrc` or `.node-version` | `dependencies`, plus `components` for every component. |
| `.github/dependency-exceptions.json` | `dependencies`. |
| `THIRD-PARTY-NOTICES.md` | `docs` and `dependencies`. |

Markdown under `third_party/` is upstream content. The docs check skips it because its relative links point into the upstream repository.

### Jobs

`dependencies` and `components` run after `selection`, in parallel with `docs` and `automation`. Selection lists the selected components. `foundation` evaluates both jobs like the others: a selected job must report `success`, and an unselected job must report `skipped`.

- **dependencies:** runs the checks listed in the [dependency policy](dependencies.md#ci-enforcement), including `go mod verify` and `govulncheck`. It has no secrets and reads only the Go module proxy, the Go checksum and vulnerability databases, the npm registry, and recorded upstream repositories.
- **components:** sets up Go from the `toolchain` line of `go.mod` and runs `go build`, `go vet` and `go test` with `-mod=readonly` for each selected component. Build checks use the produced binary. Short component checks share this job and its module download. A component gets its own parallel job only when a measured run shows that the shared job is the bottleneck.

Both jobs cache Go module downloads by the hash of `go.sum` and npm downloads by the lockfile hash, never `node_modules` or results, including the test results the `go` command caches. Adding either job changes the full-mode run, so the PR that registers the first component records a new full-mode baseline and bound in the timing table.

```sh
go mod verify
govulncheck ./...
npm ci --ignore-scripts
npm audit signatures
node .github/scripts/check-dependencies.mjs
go build ./<dir>/...
go vet ./<dir>/...
go test ./<dir>/...
```

## Boundaries and releases

Verification uses read-only tokens and disposable runners. Only the metadata-only PR-closing job has pull-request write permission; it does not check out contributor code. Do not expose account secrets, personal data, or production services to PR code. Actual model/provider calls and subjective quality evaluations run separately in explicitly authorized environments.

The [release workflow](releases.md) requires successful dev push CI for its exact source commit. A PR result for a different merge candidate is not a substitute. The [PR policy](pull-requests.md) governs integration; CI success does not authorize publication or deployment.
