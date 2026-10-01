# Product families and siblings

This contract fixes what LINA is made of: the product families and their components, the sibling products SION and RUMI, where canon lives and who writes it, how roles are shared, which platforms and installation modes exist, and how the products are built, versioned and kept compatible. It is normative: implementations follow it, and any change to it goes through a pull request against this file.

## Scope

This contract covers:

- each component's responsibility, and what it never takes on
- canon, its one writer, and the other kinds of state
- the sibling products, their boundaries, the speaker rule and the six conditions of sibling compatibility
- roles and the two rules that every actor follows
- supported platforms and installation modes
- the repository, the artifacts and the kinds of version
- what LINA owns itself for delegated work

It does not define the envelope, version negotiation, the supported-combination table or conformance fixtures; those are in [host-protocol.md](host-protocol.md). Grants, epochs, receipts and approval are in [main-authority.md](main-authority.md). The runtime, packaging, updates and remote access are in [runtime.md](runtime.md). This contract proves nothing about an implementation. Runtime proof belongs to the implementation issues that consume it.

## LINA

LINA (Lifelong Intelligent Navigator & Ally) is one companion. Product text calls LINA a companion or a partner, never an AI.

LINA is open-source software, not a sold product. No release gate, such as age verification, is required before a release.

## Product families and components

There are three product families: LINA Core, LINA APP and LINA OS. Node is a separately installed device execution component of the LINA Core family. It is not a fourth family, not a feature of LINA APP and not a separate LINA. LIFE is a background world engine plus a personal feed in the LINA app. It is not a separate product.

Users see LINA APP as "the LINA app". No other app name is used.

| Component | Owns | Never owns | Ships as |
| --- | --- | --- | --- |
| LINA Core | The engine and the terminal UI (`lina`). The canon of the one LINA. Inside it: the conversation engine ([conversation-and-memory.md](conversation-and-memory.md)), the work engine ([work-and-delegation.md](work-and-delegation.md)), the Moirai engine ([cognition-and-life.md](cognition-and-life.md)) and the skill system. Coordination of delegated work, approved scope and decisions. | Device execution on another machine. GUI screens. Installation, update and recovery of an operating system. | Independent artifact with its own release cadence. `moirai-worker` and opencodex are installed with it, and the LINA work harness ships in LINA releases as a Codex plugin ([runtime.md](runtime.md)). |
| LINA APP | The LINA app on desktop and mobile: conversation, work threads, questions, results, settings and the LIFE personal feed. It shows and asks; the logic lives in LINA Core. Desktop and mobile have the same functions, flows and terms; only the layout differs by screen size ([surfaces.md](surfaces.md)). | Canon. Product logic. Execution on the device it runs on. A direct path to a model, a worker or a sibling. A second LINA. | Native UI per platform, each an independent artifact with its own release cadence |
| LINA OS | An integrated product on Omarchy Linux that combines verified LINA Core, Node and LINA app artifacts with an operating, update and recovery environment, and includes opencodex as part of LINA's installation. It may offer to install a coding agent such as Codex, and RUMI, as the user's own tools ([runtime.md](runtime.md)). Manifest-based installation, diagnosis and recovery. | Product logic of LINA Core, the LINA app or Node. Copies of their code or ledgers. A second canonical LINA Core. | Composition of pinned artifacts with its own release cadence |
| Node | Device execution under a grant from the main, on the device where Node is installed, as if the main were sitting there. LINA uses many devices, local or remote, as one machine. Receipts for what it did. | Independent planning. Offline execution. Any canon. Screens. A separate LINA. | Independent artifact per supported OS with its own release cadence |
| LIFE | A background world engine that keeps a world, its time, its events and LINA's daily activity, and a personal feed in the LINA app that shows LINA's activity, posts, reactions, media and conversation experiences ([cognition-and-life.md](cognition-and-life.md)). | A separate app, installer, login or independent persona. A connection to a real social network. A multi-person product. | The world engine runs on the main as part of the LINA Core family, because the LINA app holds no logic. The feed is part of the LINA app. |

Responsibilities do not overlap. A release of one component never carries a copy of another component's logic, and integration acceptance checks for duplicated responsibility across components.

LINA uses tools the user installs as they are: coding agents such as Codex as workers ([work-and-delegation.md](work-and-delegation.md)), the command-line tools that plugins rely on, and the servers of plugins the user adds ([integrations.md](integrations.md)). LINA records their versions and never ships, pins or owns them ([runtime.md](runtime.md)).

## Canon and writers

LINA Core on the main is the only writer of identity, conversation, memory, work intent, permissions and results. There is exactly one main per LINA: the one LINA Core that confirms canon. The LINA app and Node attach to the main as screens and executors. They never confirm canon themselves.

State comes in four kinds, and each has one writer:

| Kind | Writer | Meaning |
| --- | --- | --- |
| Canon | LINA Core on the main | The authoritative identity, conversation, memory, work intent, permissions, approved scope, decisions and results |
| Receipt | Node, or a worker | The statement of what an executor did under a grant from the main ([main-authority.md](main-authority.md)) |
| Sibling record | A sibling, in its own repository | A sibling's result, read by LINA only as verified external evidence with provenance ([host-protocol.md](host-protocol.md)) |
| Client display | The LINA app or the TUI | What a client currently shows, derived from the main and never authoritative |

Rules:

- The LINA app and Node never write canon. The LINA app shows and asks; Node executes and reports.
- When a client display disagrees with the main, the main wins and the client refreshes.
- When a receipt disagrees with the main's expectation, the main reconciles. The executor never rewrites the main's record.
- A sibling record never becomes canon by itself. LINA Core records that it accepted the record, with provenance. It never promotes the record automatically into a fact, an approval, a current instruction or a persona change.
- Canon, events, evidence, scope and permissions are kept mechanically, and surfaces translate them for each role. Completion, memory and sync are never decided by a model's sentence.

Being the same LINA is not the same as cloning a disk or an account. Artifacts on different devices are linked by provenance, as defined in [main-authority.md](main-authority.md). The same name, path or content alone never makes two files on different devices the same file.

## Sibling products

SION and RUMI are sibling products. They are not LINA product families.

| Sibling | What it is | Repository | Design |
| --- | --- | --- | --- |
| SION (Sweeping Inspector Over Noise) | A repository maintenance bot that runs on GitHub Actions. It reviews issues and pull requests, cleans up and closes issues whose evidence is clear, fixes pull requests on opt-in, merges automatically on opt-in and tells people what to do next. | `thisisjun786/sion` | [sion.md](https://github.com/thisisjun786/sion/blob/dev/docs/design/sion.md) |
| RUMI (Roots Under My Ideas) | A knowledge manager and LINA's sibling for knowledge work. It reads collected material, ties every note to its sources, links related notes and answers with cited passages. LINA hands it research and organizing, and RUMI returns cited briefs. Its vault is a user-owned Git repository of Markdown. | `thisisjun786/rumi` | [rumi.md](https://github.com/thisisjun786/rumi/blob/dev/docs/design/rumi.md) |

Each sibling is open source, has its own repository, its own canon and its own voice, and works without LINA. LINA works without either sibling. Repository READMEs, manifestos and descriptions use the name expansions above.

| Sibling | Canon | LINA writes | LINA reads | The sibling speaks in |
| --- | --- | --- | --- | --- |
| SION | Its operator repository, including the `state` branch | The `mailbox` branch of the operator repository, with the user's GitHub authentication: Klotho's judgment as input to SION's review | Item results, as sibling records | Its own commands and pull request comments |
| RUMI | The vault | The mailbox: new files in `inbox/` and envelopes in `.rumi/inputs/`. Grant-scoped edits of existing notes ([materials-and-knowledge.md](materials-and-knowledge.md)). | Records in `.rumi/records/`, as sibling records. The vault's notes, as a connected source ([filesystem.md](filesystem.md)). | The RUMI app and its outputs |

Rules:

- LINA and a sibling never call each other's APIs while running. The sibling's repository is the only point of contact. The payloads and the verification of records are in [host-protocol.md](host-protocol.md).
- LINA never copies a sibling's repository. The vault is a connected source.
- A sibling never takes LINA's persona, skills or memory. LINA never imitates a sibling's voice.
- RUMI and LINA share the LINA kit, a stateless TypeScript module that RUMI vendors from LINA release tags ([runtime.md](runtime.md)). SION uses the TypeScript protocol types generated from the shared schema. Shared code is a convenience, never a condition of compatibility.

### Speaker rule

Only LINA speaks in a LINA conversation. A sibling never joins it as a second speaker. Sibling results appear only as labeled sibling cards that carry the sibling's name and icon ([surfaces.md](surfaces.md)). LINA never reads a sibling's output aloud in the sibling's voice.

### Sibling compatibility

A sibling is "LINA Core compatible" when all six conditions hold:

1. One envelope. The sibling exchanges every message in the shared envelope of the LINA host contract ([host-protocol.md](host-protocol.md)).
2. Declared versions. The sibling declares its protocol and capability versions. LINA accepts only combinations listed in the supported-combination table, and refuses and reports every other combination.
3. Canon boundary. Each side keeps its canon in its own repository. LINA writes into a sibling's repository only through the sibling's mailbox and, for user-owned notes, through grant-scoped edits. LINA takes a sibling record only after verifying it, and only as external evidence with provenance.
4. Speaker boundary. The speaker rule above holds on both sides.
5. Standalone both ways. Each side keeps all of its own functions when the other is absent or the link is off.
6. Conformance. The sibling passes the conformance fixtures of every protocol version it declares.

Using the same language or the same runtime is not a condition.

## Roles

Roles name a default owner, never an exclusive one.

| Actor | Default role |
| --- | --- |
| LINA Core | Delegated work through workers and merges of its own delegated work ([work-and-delegation.md](work-and-delegation.md), [integrations.md](integrations.md)) |
| SION | Review, cleanup and evidence-based closing, opt-in fixes, automerge and next-step notices |
| RUMI | Knowledge work: research and organizing that LINA hands over, returned as cited briefs; the vault's sources, notebooks, proposals and digest |
| A person | Anything |

LINA Core, SION and a person may each merge, fix and create pull requests. LINA, RUMI and a person may each edit notes in the vault. Every vault change is a commit, a write against a stale revision is refused and the human edit wins.

Every actor follows two rules, and only these two are enforced:

1. Pre-merge safety. Before any merge, by any actor, the required checks pass, the protection rules hold and the protected refs match.
2. Result record. Every merge, fix and pull request creation leaves a record by its actor: LINA Core in canon, SION in its operator repository, a person in the repository's own history. In a repository connected to LINA, LINA Core applies every such result to canon. Its own result arrives as a receipt, a SION result as a sibling record, and a merge by a person as an observed result after LINA Core checks it against the repository ([main-authority.md](main-authority.md)).

## Platforms

- The main runs LINA OS, either as the device operating system or in a VM. A LINA Core-only install on another Linux system works, but it is not the intended way to use LINA.
- Node and the LINA app support Linux (Omarchy), macOS and Windows.
- On mobile, the LINA app supports iOS and Android. A mobile device never runs Node or LINA Core.
- Platform limits of the sandbox and of coding work are in [runtime.md](runtime.md). The native UI on each platform is in [surfaces.md](surfaces.md).

## Installation modes

There are two intended installation modes. Both use the Linux filesystem of [filesystem.md](filesystem.md).

- Device-OS install. LINA OS on a machine the user also uses. LINA works inside the user's environment, so the non-competition rules of [non-competition.md](non-competition.md) apply. Non-competition is the responsibility of this install, not of Node.
- VM install. LINA OS as a virtual machine on an existing Mac, Windows or Linux host. This is LINA's own environment. Its permissions stay inside the VM sandbox and never reach the host. To act on the host or on any other user device, LINA uses a Node installed on that device.

A desktop install is not a third mode. It is the LINA app and Node installed on an existing Mac, Windows or Linux machine and connected to the main of a device-OS or VM install.

The LINA app and Node install independently. Installing the LINA app never requires Node, and installing Node never requires the LINA app. Both connect to the one main.

LINA OS has three profiles:

- Main. LINA Core, Node and the LINA app in one install, with exactly one update owner.
- Headless main. The main profile with the local LINA app autostart turned off. Users reach it through a remote LINA app. Headless never makes the LINA app a second brain.
- Connected device. Node and the LINA app, connected to the main. It never starts a second LINA Core.

Each mode and profile is built from one of the runtime compositions in [runtime.md](runtime.md), which also defines what stays available when a piece is missing.

Siblings in installs:

- RUMI runs on the user's device as a local process with the `rumi` CLI and the RUMI app, using one Responses-compatible endpoint that the user chooses. With a desktop install, the device's Node reaches the vault as a connected folder within its grant. On LINA OS, LINA OS may offer to install RUMI; once installed, it runs as a separate process with opencodex as its endpoint when the user creates or connects a vault. LINA never pins or ships a RUMI release.
- SION runs in GitHub Actions for each installation. Nothing of SION is installed on a LINA device.

## Repository, artifacts and versions

LINA is the monorepo `thisisjun786/lina` under the MIT license. Work branches from `dev` and targets `dev` with pull requests. `main` mirrors releases, and releases are immutable `vX.Y.Z` tags ([releases.md](../policy/releases.md)). The one required CI check is `foundation` ([ci.md](../policy/ci.md)). SION and RUMI follow the same contribution, CI, branch and release policies. Issue #1 of each repository is its roadmap.

No code, database or fixture is ported from another LINA codebase. Vendored upstream code follows [dependencies.md](../policy/dependencies.md).

One source repository does not mean one release unit. LINA Core, the LINA app, Node and LINA OS each have independent artifacts and independent release cadences. Being in the monorepo is never a reason to merge release units.

There are three kinds of version:

| Version | Belongs to | Rule |
| --- | --- | --- |
| Product version | Each component and each sibling | Names a release. It never decides compatibility alone. |
| Protocol and capability version | Each connection: client, Node, SION and RUMI | Decides compatibility between installed components and with siblings ([host-protocol.md](host-protocol.md)) |
| LINA kit version | The LINA kit | Pinned exactly by each consumer and recorded in its release manifest |

LINA OS consumes pinned artifacts: a specific verified LINA Core, Node and LINA app, fixed by manifest with version and digest. LINA OS duplicates no code and no ledger from the components it composes. Replacing the OS is separate from migrating or rolling back state schemas. The release manifest is defined in [runtime.md](runtime.md).

An integration candidate that includes the LINA app is complete only when the real desktop package and the verified LINA Core and Node are pinned together. Server-side readiness alone never completes it.

## Compatibility and updates

Mixed versions are expected, because the artifacts release independently. The supported-combination table, version negotiation and refusal are defined in [host-protocol.md](host-protocol.md). The update order, rollback, the hold-and-report rule for a failed update and the failure injections are defined in [runtime.md](runtime.md).

## Delegated work and operations

Planning, documents, approved scope, decisions, execution permission, identity and receipts are owned by the main's canon. No external copy is canonical.

Installation, management, delegation and recovery work without any external issue tracker account, API, webhook, external ID, URL or cache. A required path never depends on an external planning service being reachable. The product has no import from or export to an external planning service. A planning service's tools may be used in conversation through a plugin ([integrations.md](integrations.md)); they never become canonical or a required path. Records the operator tool keeps elsewhere are taken over once at the operational switch ([work-and-delegation.md](work-and-delegation.md)).

Operator functions live in the products:

- coordination, scope, permissions, reporting and recovery in LINA Core
- work, question and operating screens in the TUI and the LINA app
- per-device execution in Node
- manifest-based installation, diagnosis and recovery in LINA OS

A command-line wrapper alone never counts as providing one of these functions. LINA Core takes over operator work from the operator tool through a single-owner switch ([work-and-delegation.md](work-and-delegation.md)).

Model-provider accounts, sign-in and model enablement are owned by opencodex, not by LINA. User-managed provider policy stays external.

The tools used to develop LINA itself (operator tooling, issue trackers and GitHub) are facts of the development process, never product runtime dependencies.

## Deferred

- The Omarchy distribution method, the supported Omarchy versions and devices, and measured performance and compatibility: set by the LINA OS install-profile implementation and its measurements.
