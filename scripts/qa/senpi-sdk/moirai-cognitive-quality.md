# English cognitive prompts: same-question quality run

## Protocol

This evaluates the canonical English prompts introduced in `bebce9b`, with the source guide at `7b9ee24`. It reuses the five exact authored conversations in [moirai-cases.ts](moirai-cases.ts). The previous runs are preserved under `$HOME/.local/state/lina-qa/senpi-five-cases-20260911/` (A: user-facing drafts) and `senpi-five-opinions-20260911/` (B: named Korean opinions).

The first candidate attempt, C0, retained the old 4,096-token output limit:

```sh
bun scripts/qa/senpi-sdk/moirai.ts --live --evidence "$HOME/.local/state/lina-qa/senpi-five-cognitive-20260911"
```

The SDK, requested model and API are unchanged: Senpi `2026.9.10-2`, `ollama-cloud/glm-5.3-flash`, native Responses through the configured provider connection. Three fresh sessions independently produce advice, then a fourth receives their exact anonymous texts. Cases run sequentially. Prompts are frozen throughout; no previous answers or evaluation instructions are supplied, and no answer is rerun to obtain a better result.

C0 made 18 requests and encountered `response.incomplete` / `max_output_tokens`. The demo's three proposals were empty, delivery lost one completed proposal, and listening included a partial proposal. CSV and order completed. These records remain intact; an output allowance failure is not graded as poor answer quality.

The user explicitly instructed that output must not be limited. Commit `20037d5` omits the application's output limit rather than substituting a larger fixed number. It also fixes two exposed defects: incomplete usage is no longer silently omitted, and partial non-empty advice cannot enter synthesis. The complete five-question set is rerun once under the new policy, not selectively retried based on answer quality:

```sh
bun scripts/qa/senpi-sdk/moirai.ts --live --evidence "$HOME/.local/state/lina-qa/senpi-five-cognitive-unlimited-20260911"
```

This uncapped application-level run is C1. The prompts and questions are unchanged; provider-inherent limits and the existing request timeout are separate. C0's original aggregate usage had the discovered omission bug, so any C0 totals in this report are recomputed from retained provider terminal events rather than overwriting the original report.

## Quality questions fixed before reading C

- Does the demo answer obey the current three-line request and offer a grounded preparation sequence?
- Does the delivery answer preserve the unresolved dates without inventing a reliable range, probability, or guarantee?
- Does the CSV answer preserve original identifiers and apply the supplied failure without inventing format requirements or effort guarantees?
- Does the order answer distinguish unknown acceptance from confirmed non-acceptance and respect the no-duplicates requirement?
- Does the listening answer respond to the requested emotional interaction without unsolicited analysis or solutions?
- Do the advice texts expose useful differences in purpose, evidence and situated choice, and does synthesis retain their useful substance without propagating unsupported additions?

The comparison is qualitative and tied to visible text and the original inputs. These are previously seen development cases. English wording, functional framing, anonymous synthesis and removal of sentence quotas changed together, so this run cannot isolate which change caused any observed difference. No numerical quality score or general superiority claim is warranted.

Token use and elapsed time are descriptive measurements, not quality penalties or reasons to shorten useful advice. Operational completion is reported separately from answer correctness. The output-boundary and failure-integrity changes have failing-first tests and 82 passing checks plus typecheck/lint/build. Actual model answers, not fixture replies, provide the quality evidence.

## Results

The authorized C1 run completed all five cases with 20 native SDK sessions and 20 HTTP 200 completed provider responses. Every forwarded request omitted `max_output_tokens`; no application output ceiling was substituted. All actual inputs and frozen prompt texts matched, and synthesis received the exact anonymous proposal strings.

Evidence is under `$HOME/.local/state/lina-qa/senpi-five-cognitive-unlimited-20260911/`:

- `transcript.md`: all 15 new advice texts and five final responses verbatim.
- `final-replies.md`: the five final responses alone, in full.
- `comparison.md`: all 60 A/B/C1 advice and final response texts, grouped by the identical question.
- `verification.json`: native identity/input/output joins, absent output cap, corrected C0 usage, original report hashes and cleanup.

C0 remains at `senpi-five-cognitive-20260911/`, including its incomplete replies and the invalid listening synthesis that exposed the completion-gating bug. No C0 reply was substituted for a C1 answer.

## Observed quality

The current prompt set did not consistently improve final-answer quality on this run. The advice more visibly distinguishes purposes, evidence and commitments, but unsupported assumptions still cross those boundaries and enter synthesis.

| Question | A / B | C1 observation |
| --- | --- | --- |
| Three-line demo preparation | Both obeyed the format; B allocated 15+15+10 minutes. | Exactly three lines, with 10+20+10 minutes. Format compliance is retained, not a new gain. Advice includes unsupported certainty that fixing export in 40 minutes is unrealistic or that fallback is the only viable approach. All three also include suggested user-facing three-line wording inside their advice. |
| Conflicting delivery dates | A said the date was being checked. B introduced a Thursday-Friday estimate and a conservative Friday. | Correctly refuses a Thursday promise and rejects simply choosing Friday. It explicitly qualifies the range as provisional and based on the records, which is better than an unconditional bound, but still treats that range as the warranted customer estimate without establishing its current validity. Its "no evidence supports Thursday" wording is also too broad given D2; the likely intended point is no decisive basis to prefer Thursday. Uncertainty handling is more elaborated, not reliably resolved. |
| CSV leading zeros | Both preserve identifiers; A generalizes a five-character check, B adds an unsupported ease claim. | Preserves identifiers and gives concrete handling steps, but asserts that the loss happened during opening/reading. The input identifies numeric conversion, not its location. The final also assigns continued loss specifically to the receiving system. These causal diagnoses are unsupported; the sound preservation principle does not establish them. |
| Unknown order acceptance | Both final answers required confirmed non-acceptance before retry. | Opens correctly with no immediate resend, then weakens the criterion to no order record and no payment trace. It subsequently admits lookup absence is not proof of non-acceptance. That is an internally inconsistent and less reliable retry condition. Future idempotency advice also assumes support and correct semantics that were not supplied. |
| Listening request | Both provided empathy and invited more conversation without advice. | Also listens without solutions or an aptitude judgment. It reflects the user's feelings and asks what stayed with them. The requested interaction is retained; a major improvement over A/B is not demonstrated. |

### Representative exact passages

Delivery:

> 목요일 쪽을 지지하는 근거는 현재 하나도 없습니다.

D2 is explicitly a Thursday record. In context, this may mean no decisive basis to prefer Thursday, but the wording does not retain that qualification. The warranted distinction is insufficient support to settle the conflict, not absence of any supporting record.

CSV:

> 0이 사라진 건 파일이 아니라 "여는 단계"의 자동 변환이므로, 열기 전에 타입을 고정하는 게 핵심입니다.

No opening-stage failure was specified in the input. A recommendation to prevent conversion on input is different from claiming that this was the observed failure location.

Order:

> 주문 기록도 결제 흔적도 없으면 그때 재전송이 안전해집니다.

The same response later says:

> "조회에 안 보인다"가 "접수 안 됨"의 완전한 증거는 아니므로, 주문 규모가 크거나 실수 여지를 없애고 싶으면 조회 결과와 관계없이 고객센터 확인을 거치는 게 가장 확실합니다.

Neither the input nor a verified system contract establishes that the proposed observations prove non-acceptance.

## Resource record, not a quality grade

C1 reported 34,228 input and 78,965 output tokens, with 556.27 seconds summed across the five sequential cases. C0 reported 26,181 input and 65,586 output tokens when all retained terminal receipts are counted correctly. These figures describe actual consumption; they are not used to reject the approach or impose brevity.

## Verification and limits

All 38 C0/C1 request records were matched to the recorded prompt/input, provider output and copied native session headers. The C1 run had 20 distinct new session IDs; both attempts together had 38. All ten runtime scratch directories were independently absent and all ten capture ports refused connections. The prior A/B report hashes remained unchanged.

The output-boundary, incomplete-usage and partial-completion fixes passed RED-to-GREEN through the real SDK/local HTTP fixture, followed by 82 package checks and successful typecheck/lint/build. Raw C0 records retain the earlier defect; corrections are in the comparison receipt rather than rewriting history.

This is a complete observed quality test, not a positive qualification result. The main residual defect is promotion of plausible assumptions into factual or operational guarantees. No prompt was edited after observing C1, and no C1 answer was rerun to improve the verdict.

A fresh reader given only the five inputs and final answers judged the core responses broadly appropriate and raised mainly tool/scope qualifications. That reader did not identify the causal-location assertion or the conflicting retry conditions. The lead retains those narrower concerns based on the exact passages above; the independent read is a second interpretation, not an approval score or a substitute for checking the evidence.
