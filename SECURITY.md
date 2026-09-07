# Security reporting

This source candidate is prepared locally and has not been published by this preparation. There is no public security-support release
matrix or guaranteed response time. Include the affected commit or installed
release ID so the maintainer can reproduce a report against the right version.

## Reporting route

When **Security → Advisories → Report a vulnerability** is available on this
repository's GitHub page, use it to submit a private report. GitHub documents the
[enablement requirement](https://docs.github.com/en/code-security/how-tos/report-and-fix-vulnerabilities/configure-vulnerability-reporting/configure-for-a-repository).

No newly hosted repository or reporting feature has been activated by this local
preparation. A dedicated security email address is not designated here.

Existing collaborators should contact the repository owner through the private
channel used to arrange their repository access and request a confidential
handoff before sending vulnerability details. If you have no such channel, do
not guess an address from commit metadata. This interim route applies during
private development; a public reporting feature is not required to continue
private preparation.

At an explicitly authorized public visibility change, the maintainer must
immediately enable GitHub private vulnerability reporting, read back its enabled
state, and verify that the **Report a vulnerability** button is available to
reporters. These are coupled activation steps, not a promise that the feature is
already active. Do not announce public activation as complete until they pass.
If enablement fails, report public activation as incomplete and resolve the
failure before declaring it complete. See the
[publication checklist](docs/PUBLICATION.md) for the owner-controlled sequence.

Do not put exploit details, credentials, private transcripts, or user data in
public issues, pull requests, discussions, or CI logs. A repository issue is
visible to its readers and is not a dedicated confidential reporting channel.

## What to include after arranging private contact

- Affected revision, operating system, runtime mode, and relevant dependency versions.
- Minimal reproduction using synthetic data, expected and observed behavior,
  and the permission or data boundary crossed.
- Redacted logs and the likely impact; omit real tokens, cookies, account data,
  and private conversation or memory databases.

Test only systems and data you are authorized to use. Coordinate disclosure and
any patch publication with the maintainer. This policy does not promise a bounty,
legal safe harbor, a response deadline, or upstream fixes.

## Deployment boundary

Lina can invoke tools with the operating-system access granted to its runtime.
Separate agent workspaces do not provide an OS sandbox. Keep credentials,
conversation state, and backups private; review configured network exposure and
engine permissions before running it. See [runtime boundaries](docs/CODEX_RUNTIME.md)
and [repository policy](POLICY.md) for current implementation and release limits.
