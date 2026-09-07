# LINA image engine: ima2-gen

Date: 2026-09-07. Status: adoption approved by the user; integration pending refactor.
Parent: [Installable LINA refactor preparation](008_refactor_preparation.md).
Upstream: [ima2-gen](https://github.com/lidge-jun/ima2-gen).

## Decision

Adopt ima2-gen as LINA's image-generation engine and ecosystem integration.
Implement the adapter after the ongoing refactor establishes the owning modules.
This records an accepted product decision, not a completed runtime integration.
Attach the integration to the Lina-owned tool/job boundary.

LINA owns user intent, conversation and agent association, job tracking, and result
delivery. ima2 owns visual generation, its provider connections, and its studio.
Keep ima2 as a separately versioned runtime behind a narrow adapter. Treat image
generation as an optional capability for modular LINA installs; exact LINA OS
bundling and provisioning details remain implementation decisions.

## Connection and discovery contract

- Present image-generation connections separately from conversation-model settings.
- Read provider lanes, available models, readiness and supported operations from
  the connected ima2 runtime. Do not hardcode the model list from this discussion.
- Candidate discovery interfaces are `ima2 models --kind image --json` and
  `GET /api/models`; verify their schemas against the pinned implementation.
- Support ima2-owned setup and configuration. Surface connection status and an
  appropriate setup entry from LINA; do not require routine CLI use in the final UX.
- Distinguish configured credentials, service availability, catalog readiness, and
  a successful real generation. A catalog row is not proof of generation success.
- Do not assume that LINA/OpenCodex credentials are automatically shared with ima2.
  Reuse existing authentication only where the pinned integration supports it.
- Select image provider/model explicitly. Do not silently change provider or billing
  route on failure. Expose unavailable capabilities honestly.

## First implementation slice

One user request generates one image, displays it in the originating LINA
conversation, and permits a follow-up edit using that same image as a reference.

- Map agent/conversation IDs to the upstream request and terminal result.
- Preserve progress, failure and cancellation semantics supported by the pinned
  runtime. Reconcile uncertain jobs before retrying to avoid duplicate generation.
- Import successful results into LINA's managed attachment/artifact storage with
  provenance. Verify bytes, media type and ownership before displaying them.
- Retain the image and its conversation association across LINA restarts; deliver
  completion once. Keep credentials out of artifacts and diagnostic records.
- Check server discovery and lifecycle rather than assuming port 3333. Service
  ownership must distinguish a LINA-managed runtime from an existing user runtime.

Video, batch generation and opening ima2 Studio for detailed manual editing are
subsequent extensions, outside the first slice.

Additional user ideas: [periodic avatars and a Twitter-like agent daily-life feed](010_agent_daily_life_ideas.md).
These remain an idea backlog and do not expand the first implementation slice.

## Acceptance before claiming integration complete

1. A fresh connection exposes the actual provider/model list and actionable setup
   errors without fabricated ready states.
2. An explicitly selected provider creates a real image that appears in the
   original conversation; follow-up editing uses the correct source artifact.
3. Authentication failure, unavailable model and server outage produce clear errors
   without an unrequested provider switch.
4. Restart/recovery preserves completed images and prevents duplicate completion
   delivery or blind resubmission of an uncertain request.
5. Verify runtime version, discovery schema, generation/edit contracts and actual
   provider behavior during implementation. Start behavior changes with failing
   tests as required by the repository guide.

## Reference scope

The upstream [CLI documentation](https://github.com/lidge-jun/ima2-gen/blob/main/docs/CLI.md)
and README for setup, discovery and generation interfaces; these are implementation
leads, not pinned compatibility or end-to-end evidence.

Provider integration remains planned; this document does not authorize a generation call or service change.
