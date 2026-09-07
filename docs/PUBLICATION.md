# Public source and publication

Lina is an independent Apache-2.0 project with Codex as its sole execution engine.
[POLICY](../POLICY.md) owns publication and release authority. This guide defines
what belongs in the public source and what evidence to retain when publishing it.
Product contracts and future scope are documented in [runtime](CODEX_RUNTIME.md),
[plans](PLANNING.md) and [validation](VALIDATION.md).

## License and provenance

- [LICENSE](../LICENSE) contains the complete, unmodified
  [Apache License 2.0 text](https://www.apache.org/licenses/LICENSE-2.0.txt).
  [NOTICE](../NOTICE) attributes the work to **Copyright 2026 Lina contributors**.
- The project grant covers original source, documentation, maintainer-authored
  persona preset text, including the text imported from `lina-persona`, and the
  nine avatars and two app icons in the owner's 2026-09-07 attestation, to the
  extent of the rights held. Dependencies, upstream services, and third-party
  material retain their own terms.
- [Third-party notices](../THIRD_PARTY_NOTICES.md) identify reviewed upstream
  sources and distinguish HTTP integration from copying or distributing software.
  They are a scoped record, not a complete transitive dependency or ancestry audit.
- [Persona provenance](../data/personas/README.md) preserves original source
  digests, current content digests, and authored SOUL and CHARACTER modifications.
  It records the owner's confirmation of directly creating/generating all nine
  avatars and both app icons and holding their input rights. Hashes identify the
  covered files; no creation tool or specific input is inferred.
- User conversations, memory, credentials, and adopted/customized personas in a
  user's installation are outside the project license grant and source export.

Ensemble's pinned source, local patches and UC-specific BSD-4-Clause terms are
recorded in [third-party notices](../THIRD_PARTY_NOTICES.md#ensemble-social-engine).
Redistributed artifacts must retain its complete vendor license and manifest
alongside the root notices. Materials mentioning Ensemble features or use must
include the following acknowledgement:

This product includes software developed by the University of California, Santa Cruz and its contributors.

## Source and history boundary

Publish portable product plans, authored source resources and public third-party
notices. Keep private operational records, session handoffs, screenshots and
personal environment metadata out of the source and hosting attachments.
Synthetic fixtures and documented default or loopback configuration must remain
clearly identifiable as examples. Preserve required copyright, licensing and
public source attribution.

Public source history begins at an independently reviewed root. Do not import
private history or operational records into it. A clean working tree does not
establish that history is safe to publish: inspect the tracked-file set, commits,
identities, branches and tags, as well as PRs, issues, Actions logs and attachments.
Ignore rules do not remove already tracked files.

Review selected files and binary metadata in context. Pattern scans identify
items for review; they cannot prove the absence of every unknown identifier or
secret. Keep detailed privacy findings and backup records outside the public
repository. Public evidence must be redacted without losing the information
needed to assess the result.

## Review and activation

Before publishing source or changing visibility:

1. Review the exact files and history being published. Verify Markdown links,
   persona digests, image identity, redistribution rights and retained notices
   using [VALIDATION](VALIDATION.md).
2. Record source, dependency, secret and applicable installation checks against
   that revision. Include commands, outcomes and limits; distinguish local checks
   from hosted checks on the PR's combined merge candidate.
3. Confirm owner authorization for the publication action. Apply and read back
   the default branch, merge methods, required checks and protections described
   in [CI activation](CI.md#activation); recheck them after visibility changes.
4. Enable GitHub private vulnerability reporting and verify reporter-visible
   access to the form linked in [SECURITY](../SECURITY.md). A configured setting
   alone does not prove that a reporter can submit privately.
5. Inspect the published files and contributor entry points. Record the relevant
   hosted results and settings verification without exposing private records.

Retain evidence with the corresponding PR or release record. Report failed,
skipped and unrun checks distinctly; this guide does not replace those results.
Source publication does not authorize a release promotion, tag, package or
container publication, deployment, provider calls or changes to installed data.
Any such action follows its own owner authorization and acceptance evidence.

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
