# Contributing to Lina

Read [POLICY.md](POLICY.md) for development, CI and merge rules and
[AGENTS.md](AGENTS.md) for package boundaries. Product setup is in
[README.md](README.md); source CI and GitHub activation are in [docs/CI.md](docs/CI.md).

## Start a change

Use Bun from [.bun-version](.bun-version) and install locked dependencies:

```sh
bun install --frozen-lockfile --ignore-scripts
```

Start a short-lived branch from `dev` and open a PR back to `dev`. Use a linked
worktree when another task owns the checkout. Check status first and preserve
other work. For an unpublished source candidate, repository and branch setup remain a separate
owner action; follow the [activation sequence](docs/CI.md#activation).

Keep one coherent result per PR. A bug fix does not require an issue first;
discuss larger behavioral or architectural changes before committing to them.
Draft PRs are welcome while work is incomplete. Mark ready when the change is
understood, tested and ready to merge, and resolve failures and review feedback.

## Verify

Linux document tests call `/usr/bin/pdftotext`, `/usr/bin/python3` and
`/usr/bin/prlimit`. On Debian/Ubuntu, prepare them with:

```sh
sudo apt-get install --no-install-recommends poppler-utils python3 util-linux
```

CI explicitly installs Poppler in the package-test job and checks all three
executables before running the suite. A Bun dependency install alone does not
provide these system tools.

Behavior changes start with a failing test. Prefer focused tests while editing:

```sh
bun test packages/lina-opencodex/test
bun run typecheck
bun run lint
```

The full source checks are:

```sh
bun test
bun run typecheck
bun run lint
bun run ci:validate
bun run ci:build
```

CI runs the selected package suite once. `ci:build` uses the runtime asset loader
and a read-only CLI command with temporary paths. These commands require no
model account, shared daemon or production memory. Live scripts under
`scripts/qa/` are separate; inspect their requirements and obtain authorization
before using an external account or real user data.

Write the exact commands and outcomes in the PR, including failures, omissions
and unverified platforms. For UI changes attach a screenshot or recording and
describe the flow exercised. Green source CI alone is not browser acceptance.

## Choose an issue

- **Bug report:** expected/observed behavior, reproduction, version and redacted evidence.
- **Feature request:** user problem, desired outcome and a concrete acceptance example.
- **Dependency or provider compatibility:** engine/service versions, provider,
  API, model, capability, minimal reproduction and upstream reference when available.
- **Design decision:** decision needed, alternatives, constraints and acceptance criteria.

English template headings keep the contribution format consistent; Korean or
English issue/PR content is welcome. Blank issues remain available for cases the
forms do not cover. Do not post secrets or private user transcripts. Report an
undisclosed security defect using the current route in [SECURITY.md](SECURITY.md).
Use GitHub's private **Report a vulnerability** button when available; while
private reporting remains unavailable, follow the interim collaborator route.
Public issue forms are not a private vulnerability-reporting channel.

## License and provenance of contributions

Lina's original source, documentation, maintainer-authored preset text, and the
nine avatars and two app icons covered by the owner's 2026-09-07 attestation use
[Apache-2.0](LICENSE) to the extent of the rights held, with attribution in
[NOTICE](NOTICE). Contributions intentionally submitted for inclusion follow
section 5 of that license unless
explicitly stated otherwise. Submit only material you are authorized to contribute.

Preserve upstream copyright and license notices when importing code or text.
Record the source, pinned revision, license, original digest, and local changes
in the relevant provenance record and [third-party notices](THIRD_PARTY_NOTICES.md).
Do not apply Lina's license to third-party dependencies or hosted services.
For images, provide creation/source and input-rights evidence plus redistribution
terms; a filename, hash, or approval of appearance does not establish permission.
See [persona provenance](data/personas/README.md) for the existing image attestation
and the original/current preset-document records.

Keep personal paths, host/account identifiers, credentials, and private user data
out of new examples. This is a local source candidate; the
[publication checklist](docs/PUBLICATION.md) records the separate publication decision
and the review required for the final export and its independent history.

## Upstream changes

First identify the owner: Lina adapter, Codex client, OpenCodex translation,
provider endpoint, or memory service. Keep a minimal redacted reproduction and
record the tested versions and engine/API/model combination. Submit upstream
reports only when authorized; an internal diagnosis is not permission to post.
Keep a Lina regression test for the consumer contract even when upstream fixes
the root cause. Preserve contributor attribution when carrying an upstream fix.

Do not bundle dependency updates with unrelated product features. CI does not
install a contributor's CXC or paperthin setup or update their running OpenCodex.
