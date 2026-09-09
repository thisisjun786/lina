# Oracle source archive

Preserved: 2026-09-10. Archive name: `oracle-agent-experience-archive.zip`.

The local archive preserves 30 original files from the design research: three Oracle review responses, the subsequent Kernel design response, both request bundles, frozen design/source inputs, collection records, synthesis, example code and the plan-withdrawal counterexample. Original input manifests and response digests match; every copied file was checked byte-for-byte.

| Archive directory | Contents and interpretation |
| --- | --- |
| `oracle-design-review/` | Sol, Sol Pro and Latest Pro reviews; shared prompt, design snapshots, prior research, fixed source evidence, collection metadata and synthesis |
| `oracle-core-engine-design/` | Subsequent design prompt and response, inputs, extracted Kernel example, withdrawal probe, capture record and review |

The archive's `README.md` provides entry links. Its `archive-manifest.json` records provenance, size and SHA-256 for every original file. The source baseline is `329b6cb002deeabba3684e25dd9b45149dd59b0d`; archived source maps do not describe future revisions automatically.

The [current plan](000_plan.md) and [design](001_design.md) remain authoritative. The [research conclusions](003_research_conclusions.md) record adopted principles, rejected interpretations and evidence limits. In particular, the example's plan-withdrawal defect is preserved, not silently repaired or adopted. The archive includes the historical execution result record and review; archival did not rerun the example, typecheck or probe, and made no model calls.

Raw records include private conversation references and remain in a separate local artifact archive outside Git. This document inventories that archive; it does not mean the raw files are included in a clone of the repository. Retain the archive alongside any research handoff. Archive integrity does not establish LINA integration, current runtime correctness or model quality.
