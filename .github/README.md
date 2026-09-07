# Contributing to Lina

[POLICY](../POLICY.md) is the authority for development, checks, merges and
releases. Start with [CONTRIBUTING](../CONTRIBUTING.md) for setup and verification;
[the project README](../README.md) explains Lina and how to run it.

- [Open an issue](https://github.com/thisisjun786/lina/issues/new/choose) for a bug,
  feature, compatibility report or design decision. The [issue forms](ISSUE_TEMPLATE)
  show the information to include; small fixes do not require an issue first.
- [Open a pull request](https://github.com/thisisjun786/lina/compare)
  targeting `dev`. Follow the [PR template](PULL_REQUEST_TEMPLATE.md): explain the
  problem, resulting behavior, checks actually run and material limitations.
- Report vulnerabilities through the private route in [SECURITY](../SECURITY.md),
  keeping exploit details and user data out of public issues and logs.

`dev` is the default integration branch. Behavior changes start with a failing
regression test. Before merging, the current candidate must pass `dev-gate`, be
up to date with its target, have no conflicts and have resolved review conversations.
Use merge commits only; do not bypass protection. Required approving reviews are
zero, while confirmed defects still need resolution.

[CI operation](../docs/CI.md) explains the checks and branch protections;
[validation](../docs/VALIDATION.md) defines their acceptance limits. A future
same-repository `dev -> main` promotion requires explicit owner instruction,
release notes and `release-gate`. Source checks do not authorize publication or
deployment.
