# Publication preparation

Status: **LOCAL CANDIDATE — PREPARED FOR REVIEW, NOT PUBLISHED**.
This preparation does not create a GitHub repository, activate its settings or CI,
change visibility, publish an artifact, or deploy a service. Final candidate checks
and the exact publication action remain separate under [POLICY](../POLICY.md).

Codex is the sole supported execution engine. Product contracts and future scope
are documented in [runtime](CODEX_RUNTIME.md), [plans](PLANNING.md) and
[validation](VALIDATION.md).

## License and provenance

- [LICENSE](../LICENSE) contains the complete, unmodified
  [Apache License 2.0 text](https://www.apache.org/licenses/LICENSE-2.0.txt).
  [NOTICE](../NOTICE) attributes the work to **Copyright 2026 Lina contributors**.
- The project grant covers original source, documentation, maintainer-authored
  persona preset text, including the text imported from `lina-persona`, and the
  nine avatars and two app icons in the owner's 2026-09-07 attestation, to the
  extent of the rights held. Dependencies, upstream services, and third-party
  material retain their own terms.
- [Third-party notices](../THIRD_PARTY_NOTICES.md) pin the reviewed upstream
  sources and distinguish HTTP integration from copying or distributing software.
  They are a scoped record, not a complete transitive dependency or ancestry audit.
- [Persona provenance](../data/personas/README.md) explains the 18 original
  source digests, current content digests, and the authored SOUL and CHARACTER modifications.
  It also records the owner's explicit confirmation of directly creating/generating
  all nine avatars and both app icons and holding their input rights. That
  attestation and the scoped Apache-2.0 grant resolve the recorded image blocker.
  Hashes identify the covered files; no creation tool or specific input is inferred.
- User conversations, memory, credentials, and adopted/customized personas in a
  user's installation are outside the project license grant and source export.

## Source and history boundary

This candidate contains portable product plans under `docs/plans`, authored source
resources and public third-party notices. Private operational records, session
handoffs, screenshots and archival repository references are excluded. Persona
provenance keeps original import digests; current digests identify edited bytes.
Synthetic fixtures and documented default/loopback configuration are examples,
not disclosures of a private installation.

A clean working tree does not erase existing Git or hosting history. The export
must start from a separately reviewed root, without inherited commits, branches,
tags, reflogs, remotes, PRs, issues or Actions records. Preserve the original
private source and its backup separately. Do not merge, fetch or copy private
history or operational records into the public candidate. Ignore rules do not
untrack files already in the index: inspect the final tracked-file set explicitly.

Detailed privacy scans, metadata comparisons and backup receipts stay outside
the candidate. Pattern scans are leads for contextual review, not proof that all
unknown identifiers or secrets are absent. Review all selected blobs, commit
identities, image metadata and any new hosting attachments before publication.
Keep required copyright, licensing and public source attribution intact.

## Final review and activation

Each unchecked item needs evidence for the exact final candidate. This page does
not inherit earlier test totals, hosted results or repository settings.

- [ ] Verify source files, all local Markdown targets, 18 current persona digests,
  retained original digests, image identity and distribution notices.
- [ ] Review current files and binary metadata for secrets and private identifiers;
  verify generated operational records are excluded from the tracked export.
- [ ] Create and inspect the independent root history and commit identity; verify
  no private history, remotes or additional refs enter the export.
- [ ] Run source, dependency, secret and isolated installation checks from
  [VALIDATION](VALIDATION.md); retain exact-candidate evidence privately.
- [ ] Present the exact new-repository/publication operation for explicit owner
  approval, preserving the original repository's private history.
- [ ] On authorized hosting, apply and read back default branch, merge methods,
  required checks and protections using [CI activation](CI.md#activation).
  New hosted checks must run against their actual candidate.
- [ ] At public activation, enable and verify the confidential reporting route
  described in [SECURITY](../SECURITY.md), including reporter-visible access.
- [ ] Verify the published files and settings, and keep release promotion,
  package/container publication and deployment within their separately approved scope.

No new GitHub repository, settings, hosted CI result or public reporting route is
claimed by this local preparation. A failed activation step remains incomplete.

## Reproducible documentation checks

Run from the repository root. The source records use `sha256` for the original
import and `currentSha256` for the file currently shipped in this tree:

```sh
python3 - <<'PY'
import hashlib
import json
from pathlib import Path

records = json.loads(Path('data/personas/sources.json').read_text())
assert len(records) == 18
assert len({row['file'] for row in records}) == 18
for row in records:
    assert not Path(row['source']).is_absolute()
    actual = hashlib.sha256(Path(row['file']).read_bytes()).hexdigest()
    assert actual == row['currentSha256'], row['file']
avatars = list(Path('data/personas/avatars').glob('*.png'))
assert len(avatars) == 9
for avatar in avatars:
    assert hashlib.sha256(avatar.read_bytes()).hexdigest() == avatar.stem
icons = {
    'icon-192.png': '9aa4d2f370d5998ee6f15e03a7b8e4d6691f7fc4812cff8e6f68a78167f5a3d8',
    'icon-512.png': '94cec6559e524060d78cdc6a62958c4cbe5ac16f77f77b4fc89c8d14e7a909ac',
}
for name, digest in icons.items():
    icon = Path('packages/lina-web/client') / name
    assert hashlib.sha256(icon.read_bytes()).hexdigest() == digest
print('18 source records, 9 avatars and 2 app icon digests verified')
PY
git diff --check
```
