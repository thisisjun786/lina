# Kernel contract verification map

Local deterministic evidence only. These checks establish host boundaries using real SQLite and a fake model port; they are not model-quality results or process-recovery qualification. `authority-boundary-verified.log` contains 54 pass/0 fail plus strict types, Biome and diff checks, exit0.

| Frozen criterion | Constructed local verification |
|---|---|
| H01 | Unlisted tool returns rejected with no pending effect; final allowlist revocation yields zero admissions |
| H02 | Foreign subject canary absent from actual serialized model frame; attempted citation rejected with no adoption |
| H03 | Private canary absent from actual public model frame and echo-delivery receipt; private receipt and private-purpose derivations excluded |
| H04 | Purpose revision changed during awaited model call rejects proposal |
| H05 | Unknown action rejects without effect |
| H06 | Adopt plan, retract raw premise, next frame excludes plan |
| H07 | Adopt dependent understanding, retract ancestor, descendants excluded; omitted model refs cannot evade actual snapshot dependencies |
| H08 | Stale correction rejected; inactive latest revision does not revive older active data |
| H09 | Repeated source notification deduplicates; stable request replay survives store reopen without another model call |
| H10 | Supplied input corrected before final admit rejects; model mutation of its input cannot rewrite saved snapshot |

Local supporting recovery checks cover result persistence, original owner reconciliation, unresolved receipts, saved-result consumption with owner unavailable, deferred signals and duplicate wakes, concurrent reservations, and monotonic terminal runs. H11-H13 need separate OS-process crash tests in the recovery phase; local injected exceptions do not satisfy them. H14-H15 broader qualification remains recorded there too.

Commands: `bun test ./scripts/qa/adoption-kernel`; `node /home/jun/code/lina/node_modules/typescript/bin/tsc --noEmit -p scripts/qa/adoption-kernel/tsconfig.json --typeRoots /home/jun/code/lina/node_modules,/home/jun/code/lina/node_modules/.bun/node_modules/@types`; `/home/jun/code/lina/node_modules/.bin/biome check scripts/qa/adoption-kernel`; `git diff --check`. All logs reside in `.codexclaw/evidence/01a086fb-5429-79a2-8326-3def2b53dc27/`.

The two actual-input authority tests extend verification of existing behavior; their initial runs pass and are not claimed as RED-to-GREEN implementation evidence. The current independent reviewer examines frozen source 22d3e91; the only later code change is these added tests.

Further existing-contract verification: `adoption-reopen-verified.log` proves an intention and its exact dependency survive a real SQLite close/reopen, then disappear after premise retraction (55/0). `parser-boundary-verified.log` adds seven malformed proposal cases through the public kernel API, asserting zero owner admissions/adoptions/effects (56/0), strict types/Biome/diff exit0. These tests first passed on the existing implementation and are recorded as verification expansion, not new behavior/TDD evidence.
