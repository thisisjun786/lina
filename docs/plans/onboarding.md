# Conversational onboarding and agent creation

Status: supported product contract. Verify the current candidate with the checks in [VALIDATION](../VALIDATION.md). The future navigation redesign must preserve this flow.

## First user introduction

First entry is a one-time, sidebar-free conversation with Lina. Ask for the user's preferred name/address first, then everyday/work context, interests/use cases and communication preferences, one question at a time. Do not require an introduction form, infer private demographics, or finish merely because a turn/time target was reached. Users may correct, retract, defer an individual question or end the introduction early.

The four basic fields remain `address`, `context`, `interests`, `communication`. A declined/deferred answer is stored separately with an exact source quote, not as a profile answer. An absent answer is not a refusal. A later explicit answer clears that field's refusal marker. Older stored JSON remains readable. Automatic `ready` requires the basics to be resolved; explicit review/confirm/skip remains an early-exit path. A conversational finish requires a matching `finishQuote` from the current user message.

After confirming or skipping, choose Lina or create a personal agent. The eight domain presets are templates in agent creation, not eight extra first-run choices. Existing agents and authored preset sources must remain unchanged by template adoption.

Completed introduction cannot be restarted from settings, headers or an old URL. Old introduction URLs lead to ordinary conversation. An incomplete introduction resumes the same room. Existing conversation users are never forced back into onboarding. Initial state is determined from actual history and pending requests, not missing model/user settings; unreadable or corrupt state must not be classified as a new user.

## Lina-guided creation

Lina guides a separate conversation to choose the new agent's name and personality, using Lina's model settings and voice. The template describes the target agent; it must not replace the guide's identity. The draft and confirmed persona belong only to the target ID. Confirmed creation enters that agent's ordinary conversation.

A model or Hub outage still permits opening setup and model settings. Distinguish unconfigured, disconnected and failed inference. Creation/selection must not open an ordinary Codex session early; `sessionId: null` is valid until chat entry. Retry the same creation UUID to return to the same agent. Keep `presetId` and `templateId` mutually exclusive, separate custom/draft/template request keys and preserve supported older selection payloads.

## Persistence and permissions

`introductions.sqlite` owns room transcripts, candidates, attempts and retry receipts. Only confirmed user/persona data enters normal prompt stores; sharing an introduction with other agents is the user's choice. Do not treat introduction transcripts as ordinary conversation or learned memory.

Freeze request IDs, candidate revisions and final application revisions before applying. Duplicate retries, concurrent tabs and restarts must not lose original text, create another agent or overwrite newer settings. Preserve earlier drafts. Install ownership is acquired before opening the introduction store; shutdown rejects new writes, cancels active requests and drains work before releasing locks.

Checkpoints include introduction rooms, original text and attempt receipts. Restoring to a new home preserves the same room identity and requires the normal recovery review. Route and proxy validation must cover the exact introduction endpoints and bounded request bodies.

## First ordinary response

Include a short introduction to the selected agent and how to continue conversation/work, grounded in confirmed user context. Address an immediate user request first. Do not exaggerate autonomy, memory or capabilities. Show a small start hint in an empty chat.

First response means the durable journal has no prior ordinary assistant reply, even when a new user entry already exists. Failed first responses retain the guidance on retry; later replies and restarts do not repeat it. Send the full current persona and confirmed introduction in the model's actual developer input. A saved configuration value alone is not evidence that the model received it. Preserve strict persona/user validation and fail the turn if required instruction delivery fails.

## Acceptance

Test new/existing users, explicit refusals/retractions, older JSON, same-ID retries, concurrent revisions, first-response failures, refresh/restart and completed old URLs. Preserve failed text and request IDs. Check user-consented sharing, unchanged templates, correct guide/target separation and checkpoint round trips. Use synthetic isolated state for model and browser qualification; verify the actual next answer and restart recall separately. At 320–1440px, keyboard focus, Escape return, model-setting access and failed-request recovery remain usable without fake progress scores.
