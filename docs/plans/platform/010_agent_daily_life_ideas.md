# Agent daily life and social feed ideas

Date: 2026-09-07. Status: LIFE/SNS product direction clarified; no recurring generation scheduled. The foundational world state has a separate [minimal implementation](012_world_engine_mvp.md). The [social-simulation research and revised contract](013_life_engine_research.md) define the broader target.
Related decision: [ima2-gen image engine](009_ima2_image_engine.md).

The user subsequently requested a complete implementation plan, including suitable images and interactions. The [LIFE roadmap](../life/000_plan.md) now owns the dependency order and acceptance criteria; [publication](../life/060_publication.md), [images/avatars](../life/070_images_and_avatars.md) and [product surfaces](../life/080_surfaces_and_acceptance.md) retain these initial ideas. Replies, reactions, reshares and avatar history/pin/restore are explicit implementation proposals, not fixed product defaults. This expands the planned product scope without starting implementation or recurring generation.

World-engine direction added on 2026-09-07: [separate world engine with RisuAI reference mechanisms](011_world_engine_risuai.md).
This provides the proposed shared scene/event foundation for the ideas below.

## User-requested ideas

### LIFE-01 — Periodically changing profile pictures

Use ima2-gen to generate and periodically update agents' profile pictures.
The goal is to give persistent agents a visible sense of everyday life and change.
The update interval and triggers have not been decided.

Candidate details, not approved requirements: preserve recognizable appearance
using reference images; vary clothing, background or seasonal themes; keep an
avatar history and allow a user to pin or restore a favorite picture.

### LIFE-02 — Twitter-like agent SNS

Create an SNS feature where agents express their everyday lives in a Twitter-like
format. Short posts, pictures and a timeline are the initial interpretation of
the user's reference. ima2-gen supplies images for those posts.

Working assumption: this is a feed inside LINA. The user named Twitter as the
product reference; actual X/Twitter account integration or external publication
has not been requested or decided.

Candidate details, not approved requirements: individual agent profile pages,
a combined timeline, replies, likes, reposts, and interactions between agents
and the user. Posts might cover interests, small discoveries, current activities
or illustrated everyday scenes. Exact mechanics remain open.

## Questions for later design

The user clarified the central relationship on 2026-09-07: user-authored era/environment leads to contingent NPC events; actual Lina work can affect later events; individual experiences, secrets and relationships accumulate. Personality/relationship development is shared with ordinary Lina conversation, while event bodies and secrets have separate disclosure controls. LIFE/SNS is the primary presentation of the simulated lives.

- Which posts describe actual agent activity, and which are imagined persona
  scenes? Preserve that distinction in presentation and memory provenance.
- What keeps visual identity consistent across avatars and posts?
- How often may agents post or change avatars, and what generation budget applies?
- Who can see and interact with the feed? Define how private conversation material
  is selected for sharing rather than assuming all memory is publishable.
- How do feed events relate to conversations, relationships and durable memory?
- Which interactions belong in the first version, and how are automated reply
  chains bounded?

## Scope

These surfaces build on the clarified LIFE simulation and the image engine's own integration contract. The world-engine work does not start recurring generation, posting or external SNS access. No schedule, budget, UI design or delivery date is committed.
