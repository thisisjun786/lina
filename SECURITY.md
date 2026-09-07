# Security reporting

Include the affected commit or installed release ID so the maintainer can
reproduce a report against the right version. There is no guaranteed response time
or security-support release matrix.

## Reporting route

Submit vulnerabilities through GitHub's
[private reporting form](https://github.com/thisisjun786/lina/security/advisories/new),
also reached through **Security → Advisories → Report a vulnerability**.

If the form is unavailable, open an
[issue requesting a private contact route](https://github.com/thisisjun786/lina/issues/new)
without vulnerability details. Wait for a confidential handoff before sharing the
report. No dedicated security email address is designated here; do not infer one
from commit metadata.

Do not put exploit details, credentials, private transcripts, or user data in
public issues, pull requests, discussions, or CI logs. A repository issue is
visible to its readers and is not a dedicated confidential reporting channel.

## What to include in a private report

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
