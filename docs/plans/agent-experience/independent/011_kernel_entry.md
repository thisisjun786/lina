# Kernel implementation entry

Previous D direction: independent roadmap audit PASS, next implement standalone durable kernel per 010. Current source 3b6d75e. The audited 010 design and frozen scoring contracts are unchanged. Planned source directory still absent. No production engine imports or dependency edits needed. Reuse the independent plan verdict for the same unchanged artifact; implementation verification will be fresh.

Bounded executor scope is kernel types/parser/store/kernel/delivery and their tests only. Main owns process fixtures and contract evidence preparation within this same kernel phase, plus shared integration decisions; model/harness implementation waits its own phase. Real child-process tests finish in recovery. Host goal and transition control remain main-only.

Local verifier environment: `/tmp/lina-independent-kernel/check.sh` runs the experiment Bun suite, existing TypeScript 5.9.3 with explicit external typeRoots, existing Biome 2.5.12 and git diff --check. Shell syntax check passed; source suite has not yet run because executor is writing first tests. This launcher is temporary environment wiring, not a shipped dependency or benchmark scorer.
