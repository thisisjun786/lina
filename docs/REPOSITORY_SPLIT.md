# Lina and Lina OS product boundary

Lina owns the agent product. Lina OS composes a pinned Lina release with its OS, desktop, host and selected service modules. User personas, memory, credentials, conversations, workspaces and installation history belong to the user.

This source candidate is prepared for review and has not been published by this preparation. Repository creation, visibility, branch protection and releases require their own activation evidence under [POLICY](../POLICY.md) and [publication preparation](PUBLICATION.md).

## Ownership

| Surface | Owner | Contract |
| --- | --- | --- |
| Product packages, prompts and authored presets | Lina | Agent, conversation, persona, memory, task and computer interfaces |
| Build, tests, local installer and product QA | Lina | Reproducible product artifacts and scoped acceptance |
| Whole-product container packaging | Lina | OS consumers pin the accepted image digest |
| Optional service templates and memory integrations | Lina | Explicit paths, credentials and lifecycle ownership |
| Product contracts, plans, licenses and notices | Lina | Portable requirements and redistribution attribution |
| OS installer, guest images, desktop drivers and host connectors | Lina OS | Consume a release through documented interfaces |
| OS composition, VM acceptance and recovery | Lina OS | Pin artifacts; declare resource, filesystem and network access |
| Private development records and operational evidence | Maintainer-private storage | Excluded from the source candidate |
| Installation home, external workspaces and service volumes | User | Excluded from product and OS source exports |

No OS repository checkout is required to run native Lina. The integration boundary is the installed CLI, configured home, local controller, release identity and checkpoint format. OS updates preserve the user data home and coordinate runtime shutdown before recovery. Do not duplicate product packages in the OS tree.

## Compositions and limits

| Composition | Required | Optional |
| --- | --- | --- |
| Native Lina | Product runtime and Codex CLI; OpenCodex for model routes | Web UI, channels, external memory, host GUI connector |
| Lina with a dedicated computer | Product runtime plus selected connector | Local VM or remote desktop, explicit shared folders and credentials |
| Lina OS | Pinned product release, OS base, desktop/session manager and host connector | Dedicated desktops, external memory and selected services |

Isolation is an independent choice: direct host work, isolated task execution or a containerized whole runtime. Per-agent directories organize files; they do not restrict host access or provide independent GUI input. Dedicated computers, shared-login reuse, input takeover and desktop recovery require the [computer contracts](plans/platform/001_runtime_contracts.md) and actual backend tests.

The OS owns drivers, service registration, host permissions, boot/update/recovery and OS onboarding prerequisites. Lina owns model connection UI and common product contracts. Native model setup must remain usable without OS installation steps.

See [product plans](PLANNING.md) for planned capabilities and [validation](VALIDATION.md) for the required proof. A Linux source gate does not establish native macOS/Windows support, fresh OS installation or independent desktop input.
