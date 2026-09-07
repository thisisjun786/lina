# Agent daily life and social feed ideas

Date: 2026-09-07. Status: idea backlog only; no implementation scheduled.
Related decision: [ima2-gen image engine](009_ima2_image_engine.md).

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

These are recorded product ideas for consideration after the current refactor and
the initial ima2 integration. They do not expand the image engine's first
implementation slice or start recurring generation, posting, external SNS access,
or development work. No schedule, budget, UI design or delivery date is committed.
