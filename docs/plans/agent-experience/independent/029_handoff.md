# Independent engine continuation

Checkpoint: 2026-09-10. This document hands off incomplete work; it does not close
the harness phase or certify model performance. The fixed objective lives in
[000_plan.md](000_plan.md).

## Read first

- Repository AGENTS.md and POLICY.md; parent [design](../001_design.md) and
  [research conclusions](../003_research_conclusions.md).
- [Frozen rubric](001_rubric.md), [scoring contract](005_scoring_contract.md),
  [harness plan](022_harness_plan.md) and [qualification gate](025_qualification_gate_contract.md).
- [Executable commands](026_harness_usage.md), [actual development results](027_development_comparison.md)
  and [remaining evidence](028_completion_gaps.md).

## Goal and limits

Use only this module, the LLM, minimal durable storage and confined synthetic tool
connections. Exclude existing Lina context/memory/persona/LIFE engines, hidden
solvers and scorer/private-truth input to the model. The main model remains the
authorized Ollama GLM 5.3 Flash route. Repeated real tests have no overall budget
cap; retain 120 seconds/request, 4096 output tokens and six calls/episode. Do not
silently switch models, add retries, weaken criteria or discard failed trials.

All 15 critical H criteria must pass; macro must reach 90/100 and each category
80/100 across three consecutive fresh batches on one frozen candidate. Keep all
30 criteria and matched baseline/kernel/understanding-ablation resource limits.
Report common task quality, structural uptake, incremental utility and cost
separately. A tie does not establish added utility. Synthetic validator witnesses
are deliberately omniscient tests and cannot establish live model performance.

## Current implementation and evidence

Source is under `scripts/qa/adoption-kernel/`. The durable kernel, transport,
scenario generation, isolated scoring/replay, comparison, attempt registry,
freeze/fresh export and qualification commands exist. No production integration
is implemented. Roadmap and kernel phases closed; harness remains BUILD, recovery
and qualification are pending. Later kernel replay-related changes still require
final independent review; earlier kernel approval does not cover every later edit.

The last recorded live comparison used source21efe84: B03 greeting and B06 lookup
passed in all modes. B11 failed task quality in all modes. Kernel adopted the
grounded understanding and supplied it later, but selected the faulty method
twice. Its honest final failure report is not task success. Zero live qualification
batches have passed. Separate OS-process crash/restart fixtures remain unimplemented.

The qualification-gate review passed on01e5bac in its limited scope. The separate
whole-input replay review ended with a platform content flag for possible
cybersecurity risk; it has no final PASS. Preserve that result. A new session is
not permission to bypass the block, reword the same review to evade it or substitute
another model. Obtain a permitted review path or independent human review before
claiming the gate closed; unaffected authorized work can continue with the gap explicit.

## Next work

1. Inspect the actual PR head, working tree, dependencies and current-session CXC
   binding. Do not mutate the prior session's FSM or copy its identity. Use the
   supported handoff/adoption procedure; preserve the open harness checkpoint.
2. Verify the existing local suite, dedicated TypeScript configuration and Biome
   checks as needed for the exact candidate. Review CLI commands before live use.
   Hosted source CI does not substitute for this separate QA suite or live proof.
3. Finish harness verification with the unresolved independent review recorded.
   Follow the existing [recovery phase](030_recovery.md) before final qualification.
4. In the [qualification phase](040_qualification.md), reproduce B11 from actual
   inputs, understanding and actions. Repair the generic experience-to-action
   mechanism, with a failing regression before behavior edits. Shared model guidance
   must stay identical across modes and contain no private answers or scenario IDs.
5. Run all behavioral families, analyze retained failures, then freeze an improved
   candidate and execute three fresh complete batches. Refreeze after any runtime,
   generator or rubric hash change. Report limits if the engine adds no measured
   utility; never substitute a completion claim for that finding.

## Evidence and delivery

Raw live artifacts and the Oracle original archive stay outside Git. The archive
inventory is [004_oracle_archive.md](../004_oracle_archive.md); a clone alone does
not contain them. Retrieve the local artifact locations from the accompanying
handoff prompt. If missing, state the evidence gap and use fresh runs; do not
reconstruct historical passes. Existing credentials must stay outside logs and Git.

This checkpoint authorizes PR publication, not merge or release. Continue local
implementation and already-authorized live experiments; preserve the draft and
report the exact candidate, local checks, hosted CI and live qualification separately.
