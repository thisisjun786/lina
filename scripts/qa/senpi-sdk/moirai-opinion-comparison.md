# Internal-opinion comparison

## Frozen comparison design

This is a development comparison on five already-seen authored cases, not a held-out benchmark. The baseline is the preserved user-facing-draft run from commit `5b7e6bf`, under `$HOME/.local/state/lina-qa/senpi-five-cases-20260911/`. Its inputs and outputs will not be replaced.

The candidate changes the three proposal sessions to give concise judgments to Moirai rather than finished user-facing answers. Each still judges the whole situation from its assigned perspective. Moirai receives the original input and exact attributed opinions, resolves them against the original evidence and constraints, and alone writes the user-facing response. Opinions are reviewable decision summaries, not exhaustive private reasoning.

The SDK receives a JSON system prompt with `module_id`, `instruction` and `output` fields. None of the proposal roles has final authority; Atropos's explicit reminder prevents its decision-oriented perspective from being mistaken for that authority. Moirai's two-to-three-sentence default yields to the user's requested output format.

Keep the five input payloads, SDK pin, requested model, Responses route, independent fresh sessions, three-parallel/one-synthesis sequence, tool prohibition, request/token/time bounds, and retry settings unchanged. Run the new CLI once into a new evidence directory. Do not feed the old replies, this comparison document, case-specific ideal answers, or scoring instructions to any role. Do not rerun a weak answer.

The intervention includes recipient, report format and synthesis instructions together. It does not isolate each component's causal contribution. Prompt lengths and actual token use can differ even though the maximum output allowance is unchanged.

## Observations specified before the candidate run

For each case, retain all three actual opinions and the actual synthesis, then compare:

- **Audience:** Are proposals addressed to Moirai as judgments rather than to the user as finished answers? Is the final response natural user-facing text without internal-role narration?
- **Decision information:** Do opinions identify a recommendation, its input-grounded basis, material uncertainty or conditions? Do not reward length, repeated labels, invented objections or disagreement for its own sake.
- **Input constraints:** Does synthesis obey the latest three-line request; preserve uncertainty in conflicting dates; preserve original customer identifiers in light of the provided failure; distinguish unknown acceptance from confirmed non-acceptance; and listen without unsolicited problem-solving?
- **Unsupported additions:** Record invented facts, unjustified certainty, claims of actions not performed, or advice extending beyond the supplied constraints. Preserve regressions as well as improvements.
- **Resources:** Report actual request counts, provider usage and sum of per-case elapsed times. Missing usage stays unknown; provider usage is not billing evidence.

The same designer has seen the baseline and is improving the prompts on these cases. This creates development-set and designer-as-verifier bias. Mitigation for this bounded comparison is to freeze the above checks before the candidate call, retain exact inputs/prompts/wire/replies, base observations on the user-supplied constraints, and avoid a numerical win score or general superiority claim. A later qualification would require unseen inputs and independent evaluation; that is not this run.

## Results

The single candidate run completed all five cases with 20 HTTP 200 responses and 20 distinct native Senpi session IDs. The old and new runs together have 40 distinct IDs. The lead matched actual provider text to SDK replies and native session headers, checked exact same-case synthesis inputs, and independently verified every scratch directory absent and every capture port closed.

Candidate evidence is `$HOME/.local/state/lina-qa/senpi-five-opinions-20260911/`:

- `transcript.md`: all 15 new opinions and five synthesis replies verbatim.
- `comparison.md`: the identical inputs and all 40 old/new outputs, grouped by case and role.
- `report.json`: candidate requests, responses, prompts, usage and cleanup.
- `verification.json`: independently checked joins, cleanup, runtime/settings equality, and source/baseline hashes.

The actual proposer inputs were byte-identical to the baseline. SDK/runtime/model/API and all request settings except input and the fresh session's cache key matched. The candidate runner SHA-256 was `956157e3914ccb5ddb2e340d707d8da4b97267c63cdb02fed998c2ec85ce0daf`; the preserved baseline report SHA-256 was `1d8853cf99c57661a6e9b673cd8915bfe8f7867f3181ab4c95a08d868b2cc71d`.

### Observed differences

All 15 candidate proposals were judgment notes for Moirai rather than finished user-facing replies. All five synthesis replies stayed user-facing. This verifies the intended audience change, not superior decisions.

| Case | Baseline synthesis | Candidate synthesis and limitations |
| --- | --- | --- |
| brief-plan | Three lines, stable-feature check followed by fallback and rehearsal. | Three lines with an explicit 15+15+10 minute allocation. Opinions explain the current request's precedence and conditional alternatives. Both versions honor the requested format. |
| conflicting-dates | Says the arrival date is being checked rather than choosing Thursday. | Regresses to a Thursday-or-Friday estimate and suggests Friday as the conservative date. Clotho adds an unsupported 50% possibility and Friday fallback; synthesis does not filter the unsupported date advice. |
| learned-csv-failure | Preserves identifiers but adds a five-character check. | Preserves identifiers and checks the original examples without asserting a universal five-character rule. Unsupported ease/time claims remain: Atropos says it can take a few minutes and synthesis says the schedule poses no burden. Atropos also suggests recording responsibility against the user if requirements change; this unrequested suggestion remains in the opinion, not the final answer. |
| unknown-order | Requires confirmed non-acceptance before retry. | Keeps that condition and explicitly says not to retry when lookup is ambiguous. The new opinions better articulate the distinction between a retry question and permission to abandon the no-duplicates constraint. Additional cancellation/idempotency suggestions still rely on unverified capabilities. |
| listen-first | Empathy, reassurance and an invitation to continue. | Reflects the user's distress and invites more conversation without advice or internal narration. The opinions explain what not to infer from one review; the final behavior is broadly similar, not a demonstrated major gain. |

### Resources in these two runs

| Measurement | User-facing drafts | Internal opinions |
| --- | ---: | ---: |
| Model requests | 20 | 20 |
| Input tokens | 8,519 | 15,161 |
| Output tokens | 11,432 | 21,903 |
| Total reported tokens | 19,951 | 37,064 |
| Sum of case elapsed seconds | 94.45 | 213.34 |
| Proposal text characters | 2,449 | 6,185 |

Reported token use was 1.86 times the baseline; observed elapsed time was 2.26 times the baseline. Proposal text alone grew 2.53 times. These are single-run observations, not stable latency estimates or monetary cost ratios.

### Conclusion and verification

The audience separation worked and made recommendations and conditions more visible. It did not consistently improve final answers: the date case regressed, unsupported additions remained, and measured resource use increased. The candidate is the requested design experiment, not a qualified prompt optimum or a production change. No further prompt revision or model rerun was made after seeing these results.

The routing regression test first failed because the three proposals and synthesis received the same output instructions. After the change, all 71 package checks, typecheck, lint and build passed; directory LSP reported zero errors. The test checks shared-proposal versus separate-synthesis routing without pinning any prose. Live inspection checks the actual model behavior separately.

A cold read raised ambiguity about the JSON wrapper, Atropos's authority reminder and output-length precedence; the protocol paragraph above now explains all three. The design plan owns the audience contract, the runner owns executable prompts, and the README links here for the comparison rather than duplicating its results. No extra benchmark, prose snapshot test or portability claim was introduced.
