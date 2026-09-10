# Required model onboarding

> 2026-09-10 superseding decision: user customization of the backend and role models is cancelled. The [Moirai preset contract](../context-engines/030_moirai_refactor_plan.md#모델-운영-검증한-프리셋으로-제한) now governs model admission. Maintainers choose and qualify the supported combinations; onboarding connects the required models rather than exposing arbitrary model/role settings. The provider order, local model list and hardware proposals below are historical candidates, not admitted Moirai presets. Existing settings remain implemented until the coordinated R4 migration.

Date: 2026-09-06. Status: approved provider order and curated-list approach; initial model selection by design judgment.
Parent: [Product and OS boundary](../../REPOSITORY_SPLIT.md).

## Required user experience

At least one working model configuration is required before onboarding completes.
Show choices in this order:

1. Codex — recommended first; reuse the integrated engine's supported authentication.
2. Ollama Cloud — first-class alternative through Lina's integrated provider path.
3. Local model — filter a curated supported-model list by available hardware.

“First-class” means supported directly in Lina's product experience, not owned by Lina.
This order is onboarding presentation, not an automatic failover chain, a forced choice
or a change to the current running installation's saved model. Users may choose any
listed compatible route. Do not switch providers or send local-only data to cloud automatically.
Lina uses Codex and OpenCodex for its current execution and provider routes; see [runtime configuration](../../CODEX_RUNTIME.md). This presentation order does not certify every proposed provider/model combination.

Use the current Codex/OpenCodex integration boundaries. Verify authentication, Responses compatibility and capabilities against the pinned implementation before admitting a route. No subscription or OAuth embedding method is promised by this plan.

## Onboarding sequence

Native Lina: model route selection → supported sign-in or local setup → brief connection check → conversational introduction. An OS distribution may additionally require owner-account, Tailscale and remote-access setup; these are OS-owned requirements, not prerequisites for native Lina.
The local setup wizard itself must work without model inference.

Provider sign-in success and catalog access are intermediate states. After selection,
check authentication, model availability and a brief response. Use catalog capability
metadata for role selection. Do not run task benchmarks, quality scoring or a long
qualification suite during onboarding. Keep the connection check out of permanent memory.
No credentials, purchases, downloads or inference calls are performed by this design task.

States: unconfigured, authenticating, configured-untested, testing, ready, failed,
reauthentication-required. Preserve progress after failure. Incomplete onboarding can
be resumed; no “finish” state when no route works. Later outages do not erase setup,
memory or queued jobs, and do not silently trigger fallback billing.

## VM and hardware detection

Inspect hardware available to the inference runtime, not the physical machine hosting
the VM. GPU without passthrough is not guest VRAM. Distinguish no GPU from failed
detection. Cloud paths need no local inference GPU. CPU-only local operation remains
an advanced option, not the default local recommendation.

If a guest connects to a model server on the outer host or another device, label it
“private model server”, record its endpoint and test it. Do not call that guest-local
inference or count the remote GPU as available to guest processes.

## Hardware recommendation candidate: llmfit

Candidate: [AlexsJones/llmfit](https://github.com/AlexsJones/llmfit). The design reference describes CPU/RAM/GPU/VRAM detection, quantization/context-aware fit estimates, model
recommendations and benchmarking. Compatibility and the selected version still require implementation review.

Use a pinned version through a small adapter for candidate discovery. Preserve source,
license and model-catalog version; validate its output format when choosing the version.
Do not embed its full application or auto-upload hardware/benchmark results.

Selection pipeline:

1. Inspect free and total device memory, system RAM, driver/runtime and existing workload.
2. Reserve measured capacity for OS, agent desktops and existing services.
3. Intersect the curated list below with llmfit hardware-fit estimates.
4. Filter for runtime availability and required tool/image capability metadata.
5. Recommend a fitting listed configuration; download on selection and check connection.

llmfit's score is a fit/performance estimate, not evidence of instruction following or
reliable agent actions. Hardware fit must account for weights, KV cache at the configured
context, runtime workspace and concurrency. Discrete VRAM and unified memory use
different budgets. Catalog recommendation is not permission to download a model.

## Curated local model baseline

User correction: model suitability is selected in advance by Lina maintainers, not
established by running user-machine task evaluations at onboarding. The previous
20-task suites, latency thresholds and 30-minute stability gate are removed.

The user requires Qwen3.8-generation or newer models. Qwen3.5 entries are removed
from the onboarding list, including the previous 9B minimum. Initial local baseline:
Qwen3.8-27B. Generation and published capabilities govern admission, not parameter
count alone. New releases are curated explicitly, never selected via a moving latest alias.
This is a design selection, not evidence of measured Lina task reliability.

| Initial list | Product tier | Ollama listed download size |
| --- | --- | --- |
| `qwen3.8:27b-q4_K_M` | Default local baseline | 18 GB |
| `qwen3.8:27b-q8_0` | Higher-precision option for larger memory | 30 GB |
| `qwen3.8:27b-bf16` | Advanced high-memory option | 56 GB |

These are precision variants of one model, not three capability generations.
Catalog references retained for this design (not reverified during public preparation): [official model card](https://huggingface.co/Qwen/Qwen3.8-27B)
and [Ollama tags](https://ollama.com/library/qwen3.8/tags). Ollama lists text/image input
and tools support. Resolve full digest and compatible runtime version before shipping.
The listed download sizes are not VRAM requirements. Do not infer that all advertised
256K context fits on the selected hardware. Later-generation experimental models are
not admitted solely because their release date is newer.

Use 24 GB discrete VRAM as an initial screening tier for the 18 GB Q4 package, not a
promise that every 24 GB GPU configuration fits. Remove the previous 12 GB entry tier.
llmfit accounts for free memory, context/KV cache, runtime and desktop overhead; larger
precision variants need their own fit calculation. Unified memory has a separate budget.
If no current-generation entry fits, recommend Codex/Ollama Cloud instead of downgrading
to an older or smaller excluded model. Optional private model servers remain available.

Start fit estimation with a 16K context and one concurrent inference slot; record those
assumptions in the manifest. Two agent desktops may queue inference. Larger contexts
and concurrency require a new fit estimate, not a user task evaluation. If no listed
model fits, offer Codex/Ollama Cloud rather than silently choosing a sub-floor model.

Runtime/integration testing remains ordinary development work. It does not become an
onboarding score, an install-time benchmark or an invented performance guarantee.

## Delivery and acceptance additions

Implement provider onboarding after qualifying the required image/tool routes.
Implement the curated catalog and llmfit intersection; no onboarding workload evaluator.
Maintain the initial list above as versioned configuration, not hardcoded UI logic.

| ID | Scenario | Pass evidence |
| --- | --- | --- |
| M01 | Fresh installation | Codex, Ollama Cloud, local shown in requested order |
| M02 | GPU-less VM | Cloud first; physical host GPU not counted as guest hardware |
| M03 | Auth works but inference fails | Setup not marked ready |
| M04 | Model fits memory but is absent from curated list | Not offered as a default supported model |
| M05 | Text works but image route missing | Computer-use readiness remains incomplete |
| M06 | Add agent after provider enrollment | Existing shared provider configuration reused |
| M07 | Provider outage/quota or expired auth | Clear reason; no silent switch or unexpected spend |
| M08 | Valid local configuration | Listed model, digest, fit assumptions and connection state recorded |
| M09 | Existing installation | Saved provider/default unaffected by onboarding display order |

Version the curated list and evidence. Recompute hardware fit when model, quantization,
runtime, context or hardware changes; no user-machine quality qualification is required.
