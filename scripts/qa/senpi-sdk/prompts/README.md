# Cognitive advice system prompts

The entire template-literal value in each file below is the canonical English system prompt, not a summary or an example. The source runner imports these named constants directly; the built runner bundles the same strings. No role introduction, JSON instruction wrapper, or additional common output directive is prepended.

| Host identifier | Canonical system text | Distinctive responsibility |
| --- | --- | --- |
| `clotho` | [clotho.ts](clotho.ts) | Construct a purposeful direction, viable alternatives, their prerequisites and expected consequences. |
| `lachesis` | [lachesis.ts](lachesis.ts) | Establish which beliefs and conclusions are warranted, their support, unresolved uncertainty and grounds for revision. |
| `atropos` | [atropos.ts](atropos.ts) | Recommend a situated choice consistent with current intent, commitments, agency and consequences. |
| `moirai` | [moirai.ts](moirai.ts) | Form a grounded user-facing response from original context and anonymous advisory material. |

These are functions in one cognitive process, not three personalities or coding agents. Each advisory function considers the whole situation; the distinction is its evaluative lens, not exclusive access to a fragment of the problem. They may agree. The prompts neither demand disagreement nor assign final authority based on an identity.

The user message contains the case's original conversation. Synthesis receives that conversation plus `proposals: string[]`; each element is an exact completed advice text. Contributor names and descriptions are absent from that input. Host evidence still records roles, native session IDs, prompts, inputs and replies. The native request cache key supplies the session-to-wire join without placing that identifier in system text.

## Grounding in the original cognitive agenda

| Initial source | Preserved requirement | Prompt application |
| --- | --- | --- |
| [001_requirements.md](../../../../docs/plans/context-engines/001_requirements.md), product direction and ownership | Non-coding work; tentative user inference; current correction; stable authored identity; experience-informed behavior; separate state owners. | Constructive purposes include ordinary conversation. Belief claims stay distinct from personal reports. Situated choice respects actual intent without inventing a persona, consent or state changes. |
| [020_memory_reasoning.md](../../../../docs/plans/context-engines/020_memory_reasoning.md), premises, support and correction | Same-source repetition is not corroboration; inference differs from explicit evidence; revised premises affect dependent conclusions. | Evidence advice traces consequential claims, preserves unresolved conflict and revises conclusions. These instructions do not give the module memory-write authority or claim the memory engine is integrated. |
| [030_moirai_refactor_plan.md](../../../../docs/plans/context-engines/030_moirai_refactor_plan.md), cognitive agenda and judgment layer | Interpret purpose and evidence, apply understanding, learn from actual outcomes, preserve whole-situation judgments and natural dialogue. | Constructive advice revises failed methods; evidence advice compares expectations with observations; situated advice applies lessons within current commitments; synthesis evaluates substance rather than votes or contributor identity. |

No prompt is borrowed from a coding-agent workflow. No delivery-date, CSV or order-case answer is embedded in the system text. The known failures inform general distinctions such as evidence versus an attractive guess, unknown versus confirmed outcomes, and a mentioned possibility versus an established bound.

## Language, depth and authority

System instructions are English. Advice and final responses follow the language of the user's current message unless the user requests another language. This is deliberate: the language used to configure the pipeline is not its required output language.

There is no default sentence count. The problem determines the necessary depth. Explicit user-facing format requests remain applicable to the final response, but they do not turn internal advice into a compressed customer-service draft. Runtime capture limits remain transport safeguards; increased token use or elapsed time is not treated as an answer-quality failure.

Advice explains its recommendation and material grounds; it is not an exhaustive private reasoning transcript. None of the functions can establish execution, permission, memory updates or completion merely by saying so. Actual effects remain with their owners and require external evidence.

## Evidence boundary

This revision is a prompt-writing and local SDK-wiring change. It does not inherit the quality results of earlier live experiments and is not a production engine migration. Local HTTP fixtures prove that the actual source and built SDK runners transmit these exact assets, preserve anonymous inputs and correlate native sessions correctly; fixture replies are not live-model cognition.

The preserved local evidence path is `$HOME/.local/state/lina-qa/senpi-cognitive-prompts-20260911/`. A new paid live-model evaluation is a separate task; no improvement in real-model answer quality is claimed here.
