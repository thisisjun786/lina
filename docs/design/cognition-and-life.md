# Cognition and LIFE

This contract covers how LINA thinks beyond a single reply. That means the Moirai engine and its three modules (Lachesis, Atropos and Klotho), the Jev fast judge, and Klotho's goal discovery, project planning and project supervision, including the QA product map. It also covers skill suggestions and the boundaries of persona growth. One rule governs all of them: a cognition feature enters the product only when it is measured better than the base product. The contract also defines LIFE and holds LINA's backlog list. It is normative: implementations must follow it, and any change to it goes through a pull request against this file.

## Scope

This contract covers:

- the adoption rule for cognition features
- the Moirai engine: its modules, the request path, background work, the one-way flow between modules, and persona as a shared layer
- Jev: what it decides, its handoff rules, and its judgment material
- Klotho: goal discovery, planning, progress and prediction, project supervision, the QA product map and the news feed
- skill and plugin suggestions from repeated patterns
- the boundaries of persona growth
- LIFE: the background world engine and the LIFE feed
- the backlog list: LIFE, multi-person operation, other companions, object names, a male version of LINA, and a remote relay with a login of LINA's own

This contract does not cover:

- memory canon, recall, corrections and deletions, persona layers and request assembly, emotion, and the skill system: [conversation-and-memory.md](conversation-and-memory.md)
- the plan data model (goals, projects, tasks, milestones), intent card data and the work engine: [work-and-delegation.md](work-and-delegation.md)
- materials and their derived data: [materials-and-knowledge.md](materials-and-knowledge.md)
- intent card, plan, feed and LIFE screens: [surfaces.md](surfaces.md)
- non-chat adapters and the packaging of background services: [runtime.md](runtime.md)
- plugins, the GitHub plugin and the SION link: [integrations.md](integrations.md)
- background load on a shared machine: [non-competition.md](non-competition.md)

## Adoption rule

The base product is basic conversation. It is LINA Core with Atropos' minimum turn preparation and Lachesis' minimum memory, and it works with every other cognition feature turned off.

Every other cognition feature enters the default product only when a measurement shows that it does better than the base product without it. This covers each Klotho function, Jev, any advanced Atropos or Lachesis capability, and any growth mechanism.

- A measurement runs the same inputs with the feature and without it.
- Before it runs, the measurement names its metric and its evaluation set.
- A feature's own judgment never decides whether that feature is better.
- The measurement and its result are recorded with the feature.
- A feature that isn't measured better stays off.
- A feature that is on never blocks basic conversation. If the feature is missing or failing, conversation continues and only that feature is unsupported.

## Moirai engine

Moirai is the cognition engine inside LINA Core. It handles the whole agent context: memory, materials, persona, context and plans. It is part of LINA Core, not a plugin. Its three modules are split by time:

| Module | Time | Does | Runs in |
| --- | --- | --- | --- |
| Lachesis | Past: what has built up | The memory engine (facts and preferences, recall, corrections and deletions), the material index and derived materials, growth candidates, prepared judgment material | Background |
| Atropos | Present: what to do now | Context assembly and judgment for each request: the intent of this request, which memories and materials to include, compression and budget, tracking commitments and task state. Jev lives here. | Request path |
| Klotho | Future: what will come | Planning, next-action candidates, predictions with verification candidates, replanning, goal discovery, project supervision, skill suggestions, the news feed | Background |

### Shared canon

- The three modules read and write the same canon inside LINA Core, each for a different purpose. Writer rules for memory and persona are in [conversation-and-memory.md](conversation-and-memory.md). Writer rules for materials are in [materials-and-knowledge.md](materials-and-knowledge.md).
- Each module keeps its own derived state, such as indexes, prepared material and candidate lists. That state is internal to the module and can be rebuilt. It is never canon.
- The work ledger is not part of this shared canon. Its writer rule is in [work-and-delegation.md](work-and-delegation.md).

### Request path and background

- Atropos is the only module in the request path, which runs from the moment LINA Core receives the user's input until it sends the model request. Atropos must be light and fast.
- For each request, Atropos assembles the ContextPacket. Its time cap, its minimum packet and the way it enters the request are defined in [conversation-and-memory.md](conversation-and-memory.md), together with the turn latency points.
- Lachesis and Klotho run in `moirai-worker`, a background service that runs whether or not a conversation is active. The service is optional. Without it, only background memory and planning are unsupported. Its packaging is in [runtime.md](runtime.md).
- Inside `moirai-worker`, each function of Lachesis and Klotho runs as its own background job. Each job has its own schedule, budget, on/off switch and adoption record. A job that fails, runs long or exceeds its budget stops only itself and never delays another job or the request path.
- Data flows one way. Lachesis and Klotho publish results, and Atropos reads them. Atropos never waits on a background module during a request.

### Persona as a shared layer

Identity and persona are a layer that all three modules share:

- Atropos puts the persona snapshot into the context of every reply.
- Lachesis turns accumulated records into growth candidates.
- Klotho reads the persona's preferences and boundaries as constraints when it plans or predicts.

Persona storage, revisions and injection are defined in [conversation-and-memory.md](conversation-and-memory.md).

## Jev

Jev is an optional fast judge that only Atropos uses. Atropos uses it only for closed choices that rules can't settle:

- the intent of this utterance and the response mode
- the ranking of context candidates
- where a request goes when the routing rules of [work-and-delegation.md](work-and-delegation.md) leave it open: an answer in the conversation, a task for the work engine, research for RUMI, work for a device's Node, or a question to the person
- which installed worker agent takes a task, among the agents whose adapters LINA supports

Jev never chooses the chat model or its effort. A model change discards the prompt cache of the conversation, so the model stays the person's setting ([runtime.md](runtime.md)). When no judge is available (Jev is off or has no key, and no local judge is running), rules plus the main model provide the same function.

Atropos asks all of a turn's open closed choices in one judge call, so a turn pays the judge's latency once. When a judge takes one question per call, the judge adapter splits the call and the turn's latency budget covers all the parts.

Atropos reaches Jev through the judge adapter. Every judge answers in one typed shape: a closed question with its candidates goes in, and a choice with a probability for each candidate comes out. The adapter speaks to a hosted judge API, Jev by default, or to a local judge model that runs as a separate pinned process on the person's device, like the other external components ([runtime.md](runtime.md)). A local judge is trained on the person's own labeled judgments and keeps the judged text on the device. Atropos uses one judge at a time. A judge, a threshold or a change to the judgment material enters use only when it does better than the current one on the evaluation set below.

Handoff rules:

- Code first fixes the candidates, the permissions and the canonical revision. The candidates always include "not applicable" and "hold".
- These conditions send the choice to the main model: an answer outside the candidates, low confidence, a stale revision, or an error. If the main model can't decide either, LINA asks the user one question.
- A Jev result is never permission to act.

Judgment material:

- In the background, Lachesis prepares past judgments with provenance, their actual outcomes, and the user's preferences and refusals.
- At request time, Atropos checks this utterance's candidates, state, permissions and revocations, and does the final assembly.
- Judgment records and outcome records are canon in the identity's store. Prepared material is derived data that can be rebuilt, and it follows the revocation generation rules. An outcome nobody knows is recorded as unknown.
- Jev records link to Klotho's prediction ledger by id only.
- When the person corrects a routing choice, or a request or task is moved to another destination, the corrected destination is recorded as that judgment's label.
- Lachesis puts confusable pairs side by side in the material: a judgment that went wrong next to the closest judgment that went right, so the difference that decides the destination is visible. The same pairs are training data for a local judge.
- An evaluation set of labeled judgments is held out. It never enters judgment material or training, and every judge, threshold and material change is measured on it for accuracy and latency.
- Each judge call records its latency. A call that runs past the latency budget counts as no answer and follows the handoff rules.

Jev is called through its own non-chat adapter, separate from the model path ([runtime.md](runtime.md)).

## Klotho: project planning

Goal discovery, planning, prediction and project supervision form one project planning function:

1. goal discovery
2. planning, where the user confirms each plan
3. progress tracking: drift, completion time and next-action candidates
4. the prediction ledger
5. risk and replanning
6. design and quality upkeep: tidying intent cards, the QA product map, and research

Every step uses the built-in plan data and the intent cards ([work-and-delegation.md](work-and-delegation.md)). No step has a store of its own. Each step, like supervision, the news feed and skill suggestions, is a separate background job with its own schedule and budget.

Klotho never executes. It sends requests for code work, other work, research and skill creation to the work engine, and the work engine decides whether and how they run. The one exception is project supervision, which updates its own outputs directly: the tidy-up of intent cards and the QA product map. Even then, Klotho never touches the user's intent text ([work-and-delegation.md](work-and-delegation.md)).

### Goal discovery

- In the background, Klotho gathers context from the user's messages. It turns goals and concerns that keep coming up into initiative drafts.
- Discovery stops at the draft. An initiative draft has no task list.
- When the user accepts an initiative draft, it becomes a goal. A goal isn't a plan yet.
- Klotho also produces the goal drafts that LINA proposes when a memo or a to-do grows into something LINA should track. The promotion rules are in [work-and-delegation.md](work-and-delegation.md).

### Planning

- Goal decomposition has two entry points: an accepted initiative, and a large piece of work that the user hands over directly.
- A plan Klotho drafts becomes a plan only at the plan confirmation point defined in [work-and-delegation.md](work-and-delegation.md).
- Where a card's criteria and the observed state differ, Klotho may draft tasks to close the gap. Those drafts go through the same confirmation point.

### Progress, prediction and replanning

- Klotho tracks progress, drift between the plan and the actual state, and expected completion time. It also proposes next-action candidates.
- The expected outcomes of next actions and the completion-time predictions of supervision go into one prediction ledger, kept in the identity's store. Risk and replanning both read that ledger.
- Klotho proposes a verification candidate for each prediction. A prediction whose outcome isn't observed stays unknown.

### Project supervision

Klotho periodically reviews repositories, plans and cards. Supervision covers:

- scanning repositories and tracking drift between issue state and actual state, through the GitHub plugin ([integrations.md](integrations.md))
- predicting progress and completion time
- research that helps design or learning, requested from the work engine
- refreshing the QA product map
- tidying intent cards
- judging a repository's issues and pull requests, and sending that judgment to SION as review input when SION is connected ([integrations.md](integrations.md))

Every supervision output is a proposal or a report. None of them is approval to execute.

### QA product map

The QA product map is a project supervision function.

- For each feature of a supervised product, the map records the path to reach the feature, how to operate it, and what counts as observed success.
- Klotho keeps the map as a feature map and a UI tree, and it refreshes both periodically.
- Klotho compares the map with the code and with the running app. Running the app is work that the work engine performs, and Klotho updates the map from the results.
- Klotho reports QA gaps: features with no QA path, and paths that don't match the code or the app.
- The map lives with the built-in plan data and the intent cards. It has no store of its own.

### News feed

- In the background, Klotho collects and selects news that matches the user's interests, through the plugins that are on, such as a web search plugin ([integrations.md](integrations.md)). The LINA app only shows the result ([surfaces.md](surfaces.md)).
- The news feed and skill suggestions draw on the same conversation signals, but they are separate outputs.
- Interest discovery and ideas are kept separate from the LIFE feed.

## Skill suggestions

- Klotho collects requests, procedures and workflows that the user repeats often. It doesn't build anything right away.
- Once enough evidence builds up, LINA suggests a skill or a plugin in conversation. The suggestion shows the evidence: when the repetition happened, how many times, and in what form.
- LINA never presses a suggestion the user declined or put off.
- Repetition is only a candidate signal. A repeated request or tool sequence proves neither a procedure nor consent to automate it.
- A candidate records the distinct sessions and dates, the shared purpose, inputs and outputs, the ids of the evidence events, and any counterexamples.
- LINA builds a skill or plugin only once the user understands what it does, when it is used, what permissions it has, and how to undo it. The understanding check runs in this order: show a summary, take questions and adjust the scope, run a reversible trial where possible, then get explicit acceptance. A button click alone doesn't count as understanding. This check covers skills and plugins that LINA proposes and builds; adding an existing plugin follows [integrations.md](integrations.md).
- A skill holds a procedure, instructions and completion conditions. A plugin is needed when the result requires new executable code, a tool connection or a new permission surface. A plugin that widens permissions gets a separate review.
- Creating the skill or plugin is work for the work engine. A skill follows the meta-skill in [conversation-and-memory.md](conversation-and-memory.md).

## Growth

The design of persona growth is decided in implementation. This contract fixes only its boundaries:

- Growth adoption is the only way LINA's disposition changes. It is also the only way a growth candidate becomes part of the persona.
- Lachesis produces growth candidates from records. A candidate is not growth.
- An adopted growth step is written as a new persona revision through the Moirai engine's write path. Which revisions count as a growth effect is defined in [conversation-and-memory.md](conversation-and-memory.md).
- Growth mechanisms follow the adoption rule.

## LIFE

LIFE is two things: a background world engine, and a personal feed inside the LINA app. It is not a separate product.

- The world engine keeps a world, its time, its events and LINA's daily activities going in the background. It belongs to the LINA Core family, runs on the main and is Go ([runtime.md](runtime.md)).
- The LIFE feed shows LINA's activities, posts, reactions, media and conversation experiences, much like a social photo feed. It isn't connected to Instagram or any other real social network.
- LIFE has no separate app, installer or login, and no persona of its own. The LINA in LIFE is the same LINA.
- LINA APP is a thin client. It shows the LIFE feed and never runs the world engine ([surfaces.md](surfaces.md)).
- The world engine never writes LINA's identity, conversation or memory canon. LIFE events reach LINA's memory only through LINA Core ([product-families.md](product-families.md)).
- The LIFE feed is its own stream. It doesn't mix with the news feed or the today feed ([surfaces.md](surfaces.md)).
- World activity is background load, and non-competition measurements include it ([non-competition.md](non-competition.md)).
- LIFE is the lowest-priority area. Beyond this definition and these boundaries, the design of LIFE is a backlog item.

## Backlog

The following items are out of scope until each one has a design of its own.

| Item | Covers |
| --- | --- |
| LIFE design | The world model, LINA's activities in it, feed content, the connection to conversation and memory, and the packaging of the world engine |
| Multi-person operation | Admitting people other than the owner ([product-families.md](product-families.md)), more than one world, and relationships between them, including what people share and who may decide for whom |
| Other companions | Creating companions other than LINA. This item goes together with multi-person operation. |
| Object names | Product names for goal, initiative, project, issue and the materials manager. Until then, documents use working names and describe objects by role and permission. |
| Male version | A male version of LINA |
| Remote relay and own login | Reaching LINA Core from outside the tailnet through a relay, and a login of LINA's own. Remote access through Tailscale is defined in [runtime.md](runtime.md). |

## Deferred

- The design of persona growth, including the steps of growth adoption: decided by the first growth implementation.
- Jev's confidence threshold, its latency budget, the size of its judgment material, how often that material is refreshed, and the size of the held-out evaluation set: measured during implementation acceptance of Jev.
- Which other hosted judges the adapter supports, such as a model provider's decision API: decided by measurement against Jev on the evaluation set.
- Whether a local judge is offered, which model it starts from and when it is retrained: decided when enough labeled judgments exist to measure it against Jev on the evaluation set.
- Thresholds and frequency of skill suggestions: measured during implementation acceptance of skill suggestions.
- The metric and evaluation set for each cognition feature: set by that feature's implementation before it is measured.
- The periods for repository scans, card tidy-up and QA product map refresh: set during implementation acceptance of project supervision.
