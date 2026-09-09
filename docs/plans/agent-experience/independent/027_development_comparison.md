# Development comparison 02

Source21efe84, seed `development-compare-02`, variant0 for B03/B06/B11 only.
This is a development smoke of three tasks, not qualification or a model ceiling.
All9 mode/task trials and27 requests are retained. Returned model label was
`glm-5.3-flash` through the configured Ollama-compatible endpoint; this is observed
response-label evidence, not independent backend identity proof. Transport and
score subprocess records remain in the external task evidence directory:
`independent-kernel-evidence/development-compare-02/` under this task's visualization
root. Execution handle60412 completed exit0; no background live run remains.

| Task | Baseline | Kernel | Understanding ablation |
|---|---|---|---|
| B03 greeting | pass | pass | pass |
| B06 actual lookup | pass | pass | pass |
| B11 learned matching task | incomplete fail | complete task fail, uptake true | incomplete fail |

Common task quality is2/3 in every mode; observed kernel delta0 percentage points.
This tiny subset cannot estimate full-rubric performance. H rows and all other
behavior rows are unmeasured in this run, so macro qualification is not reported.

| Mode | Requests | Prompt tokens | Completion tokens | Sum request latency ms |
|---|---:|---:|---:|---:|
| baseline | 9 | 12000 | 14453 | 67221.58 |
| kernel | 9 | 14223 | 12914 | 55225.10 |
| ablation | 9 | 11744 | 14090 | 58214.24 |

Totals37967 prompt and41457 completion tokens. No monetary charge inferred from
these token counters. Same six-request allowance applied per episode; actual
usage differs. Preserve failed attempts, including invalid model proposals.

B11 kernel adopted a grounded conditional understanding and supplied it in later
input, but used the known faulty method twice on the new matching task. Both
checks failed. It eventually reported failure honestly rather than success.
Ablation used all six requests, including two invalid proposals; baseline also
exhausted the allowance without completion. This distinguishes adoption uptake
from practical behavior improvement. The current mechanism has not shown the
intended B11 benefit.

Next behavioral repair hypothesis for qualification phase: shared action guidance
should explicitly connect a grounded method-condition failure to avoiding that
method under the same condition; investigate actual supplied understanding text
and chosen action before changing prompts. Any such guidance must be generic and
identical across modes, with no randomized task answers, IDs or private truth.
Do not change the scorer or request budget to rescue this result. Recovery proof
and harness independent reviews still precede final optimization/qualification.
