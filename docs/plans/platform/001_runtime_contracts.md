# Runtime contracts

Status: proposed API and persistence contracts; no endpoints or tables below exist yet.
Parent: [Product and OS boundary](../../REPOSITORY_SPLIT.md).

## Records and ownership

| Record | Required fields | Invariant |
| --- | --- | --- |
| Installation | id, ownerUid, ownerName, hostId, policyRevision | Owner name is configurable, never tied to a particular local account |
| Computer | id, hostId, agentId or sharedName, backend, generation, state | Generation changes on desktop recreation; browser profile binding awaits feasibility results |
| ExecutionIdentity | id, uid, gid, home | Stable UID and directory mapping across reboots |
| InputLease | computerId, holderType, holderId, epoch, expiresAt | At most one writer; viewers never imply ownership |
| ComputerRun | id, agentId, conversationId, computerId, requestId, state | One input task per computer, durable link to original conversation |
| Action | id, runId, sequence, payloadHash, generation, leaseEpoch, state, resultRef | Duplicate ID with different payload is rejected |
| HostJob | id, hostId, runId, uid, command, cwd, resourceKeys, state, receipt | Target and privilege explicit; execution is journaled before dispatch |
| Event | id, aggregateId, revision, type, payloadRef | Reconnection uses cursor; no command replay from event consumption |

Lina core owns these domain contracts. The computer service owns computer/action
persistence; the host executor owns its own dispatch journal and process receipts.
Conversation state remains in existing stores. Cross-store delivery uses outbox records
and stable IDs; do not imply one atomic transaction across independent processes.

Computer states: provisioning → ready → stopped; any active state may become failed.
Control state is separate: unowned, agent, human, transferring. A ready computer may
have no writer and many viewers. Run states: queued, running, paused-human,
reconciling, succeeded, failed, cancelled, uncertain.

## Proposed ports

Names describe domain operations; exact TS definitions follow the backend experiment.

- `ensureComputer(binding, requestId)` returns existing/new stable computer ID.
- `startComputer(id, expectedRevision)` starts the same persistent profile.
- `inspectComputer(id)` returns actual state, generation and readiness components.
- `acquireInput(id, holder, expectedEpoch)` atomically grants ownership or queues it.
- `captureFrame(id)` returns frameId, generation, capturedAt, width, height, scale, image.
- `executeAction(envelope)` records, validates ownership, dispatches and returns receipt.
- `transferInput(id, holder, expectedEpoch)` fences previous writer before granting new one.
- `stopRun(runId)` retires input ownership and cancels owned processes where possible.
- `submitHostJob(spec, requestId)` dispatches via authenticated local executor.
- `inspectHostJob(id)` returns process evidence and persisted terminal result.

Action envelope includes computerId, runId, actionId, sequence, generation, leaseEpoch,
and observedFrameId for coordinate-sensitive actions. Kinds: screenshot, pointer move,
click, scroll, key down/up, text entry. Commands use a separate host/desktop target API.
A stale generation or lease epoch is rejected before injection. Resizing increments
display generation; the next action requires a fresh frame. Driver maps physical pixel
coordinates exactly; browser CSS dimensions do not become input coordinates.

Client-facing API proposal:

| Method and path | Result |
| --- | --- |
| GET `/api/computers` | Bound computers and observable state |
| POST `/api/agents/:id/computer` | Idempotently provision/bind default computer |
| POST `/api/computers/:id/start` | Start retained desktop |
| POST `/api/computers/:id/takeover` | Transfer input to authenticated human |
| POST `/api/computers/:id/release` | Release human input; agent recaptures before resume |
| POST `/api/computer-runs/:id/stop` | Cancel run, not delete its profile |
| GET `/api/computers/:id/events` | Cursor-based state events |
| POST `/api/computers/:id/view-session` | Short-lived, scoped viewer session |
| WS `/api/computers/:id/stream` | Authenticated proxy to selected desktop backend |

All writes use request IDs and expected revisions/epochs where applicable. The gateway
derives human identity from authentication, not request JSON. It validates origin and
computer ownership on HTTP and WebSocket upgrades. Viewer credentials are not durable
URL tokens; reconnect revalidates identity and current read/write entitlement.
Host execution has no unauthenticated or browser-direct root endpoint.

## Control transfer algorithm

1. Persist transfer intent and stop accepting new old-epoch actions.
2. Cancel queued input. Fence the input driver and wait for its in-flight action boundary.
3. Release held keys/buttons; revoke/close any old writable viewer channel.
4. Commit incremented epoch and new owner, then grant its input channel.
5. On return to agent, capture a fresh frame and resume reasoning from actual state.

Prototype defaults: 15-second lease, renewal every 5 seconds, 3-second transfer timeout.
These are engineering starting values, not measured guarantees. If the driver cannot
acknowledge fencing, leave control in transferring/failed and restart its owned input
path before granting another writer. Never grant overlapping input to meet a timeout.
On expiry stop new inputs; an already completed click cannot be undone.

Viewer disconnect does not stop the computer. A disconnected human's lease expires;
the agent may resume after the transfer procedure and fresh capture. Explicit user
pause remains paused until resumed; it is different from transient connection loss.

## Recovery and external side effects

Persist Action as accepted before injection and completed after receiving driver proof.
On crash after injection but before completion, mark uncertain. Do not blindly replay
the action. Capture current state and reconcile using an observable postcondition.
Examples: read the saved file; inspect whether a submitted item exists; inspect service
state. A screenshot alone may not prove whether a remote submission happened.

If a postcondition proves completion, record reconciled success. If it proves no effect,
create a new action under the current lease. If neither is provable, continue only work
independent of the uncertainty and report the unresolved result in the conversation.
Automatic approval does not make an uncertain operation safely repeatable.

Desktop restart preserves files/profile, not running app memory. Reopen required apps
and rebuild the task from durable state. Reboot retires leases and increments desktop
generations. Queued jobs remain queued; running jobs enter reconciliation.

Host jobs run in owned process groups/systemd scopes and record process identity plus
boot identity, not PID alone. A runtime crash queries the surviving executor journal.
An executor crash reconciles its owned scopes before dispatching another job. Failed
status persistence must not trigger duplicate execution.

Completion delivery uses a stable run-result ID and a unique conversation receipt.
Transport may redeliver; conversation insertion deduplicates. Promise one visible
completion per result, not exactly-once external website actions.

## Capacity and operational controls

Default prototype target: two running agent desktops; the authenticated browser/session
topology is selected by the shared-login experiment, not fixed to a third desktop.
Agents beyond this limit queue desktop work while conversation remains available.
Actual RAM/CPU/GPU limits are chosen after measurement. Profile disks persist even
when the runtime is stopped; resource admission never silently deletes them.

Expose computer readiness (display, capture, input, browser), queue depth, lease owner,
last successful action, model failure and disk pressure. Human UI shows running,
waiting for another agent, under your control, recovering, completed or failed.
Detailed logs retain agent/run/target identity, timings and exit status. Avoid recording
credential values and typed secrets; continuous video recording is off by default.

Root-capable agents can modify local logs and snapshots. Local history supports
debugging and recovery; it is not a tamper-proof audit guarantee. Remote model outages
stop reasoning but need not close apps or revoke persistent browser login.
