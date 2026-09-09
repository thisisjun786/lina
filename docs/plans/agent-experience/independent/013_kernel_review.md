# Kernel review repair synthesis

The independent reviewer inspected frozen commit 6ea612e and returned FAIL with three reproducible blockers. All three are accepted. They share one cause: a durable state in one subsystem was treated as final without checking the corresponding authorization or run state. The repairs preserve the existing local-owner contract and do not change the rubric.

| Finding on 6ea612e | Disposition on 22d3e91 | Regression evidence |
|---|---|---|
| Cached tool remains callable after beforeAdmit revokes its allowlist entry (kernel.ts:151) | Recheck exact current owner immediately before admission; revoked owner cancels marker and returns rejected | tool-revocation-red.log 50 pass/1 fail; green 51/0 |
| Original invocation overwrites concurrent completed reconciliation with unknown (kernel.ts:35) | Run finalization is monotonic and returns the existing terminal trace in one transaction | terminal-race-red.log 48/1; green 49/0 |
| Stale rejection leaves never-admitted marker permanently pending (kernel.ts:154) | Record cancelled without inventing an owner receipt; no reconciliation request for cancelled effect | stale-marker-red.log 49/1; green 50/0 |

Logs live under `.codexclaw/evidence/01a086fb-5429-79a2-8326-3def2b53dc27/`. `kernel-restore-verified.log` tests 52/0 and strict types/Biome/diff exit0 on the 22d3e91 source. Reviewer child 01a08762-3525-7b61-ae87-7e1b4b96a14d was reported complete and closed. Completion of review transport does not mean reviewer PASS. A fresh reviewer must verify the repaired candidate before kernel C.

Current boundary: deterministic kernel contracts, temporary SQLite owner and fake ModelPort. H11-H15 OS-process cases and live behavioral qualification belong to subsequent registered recovery/qualification phases; no such proof is claimed here. Interrupted judgment without owner effect is surfaced unknown and held; no blind model retry. Prepared frames durably list the receipt inputs supplied to each judgment. Natural-language conditional understanding remains a model responsibility.
