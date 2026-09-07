# Lina visual direction

Codex 디자인 언어, Electron/웹 공통 렌더러, 메신저형 에이전트 목록과 모바일 탐색은 목표 방향이며 이미 구현된 상태가 아닙니다. 외부 주장은 재검증하지 않았습니다.

The product direction is to adopt the
Codex design language across surfaces, typography, spacing, icons, menus, the
composer, and interaction states. Select a shareable, versioned Codex reference at a documented viewport
and scale for visual verification. Keep Lina's agent-centric navigation and conversational
identity. Desktop targets Electron; web/PWA shares the same renderer and tokens.
The plan specifies a messenger-style agent list and mobile navigation. Apply Codex styling to photo/name/recent-message rows;
use full-screen mobile lists and optional desktop task columns.
This describes the target design; the implementation has not yet been migrated.

## First setup and agent creation

The navigation rules below describe ordinary conversations. First user setup stays
a one-time, sidebar-free conversation with Lina, with no return-to-onboarding link
or settings entry. Lina also guides separate agent-creation conversations before
the confirmed agent starts its own chat. Preserve the [implemented setup contract](../../docs/plans/onboarding.md).
The [planning index](../../docs/PLANNING.md) records current ownership and the
difference between planned interface changes and implemented behavior.

## Design Read

Agent conversation workspace, read and used repeatedly over a long conversation.
The conversation and actual work state carry the hierarchy. Use quiet surfaces, system
and Korean-safe typography, Codex control density and separators. Keep the original
`l.` mark. The app keeps its symbol identity; approved character portraits belong only to agent avatars and profile settings.

Design variance: 2/10. Motion intensity: 2/10, one small activity symbol. Density: D3 personal chat.
This utility surface does not need generated concept art, gradients or ornamental cards.

## Token ownership

`client/tokens.css` owns color values for both modes. Components use semantic tokens
for main/sidebar/elevated surfaces, text, muted text, borders, focus/selection, buttons
and status. This document describes their roles rather than duplicating numeric values.

Dark: charcoal surfaces with enough separation between navigation, conversation and
input; off-white text and readable muted labels. Light: white and light neutral gray
surfaces with black text. Selection uses the Codex neutral surface treatment;
focus and semantic status colors remain accessible and are verified separately.
Primary send/action buttons use high-contrast neutral treatment.

Use platform system fonts with Korean fallbacks, modest font weights, a consistent
spacing scale and restrained radii. Avoid simulated window traffic lights or controls
without behavior. Existing history, draft recovery and source expansion remain usable.

## State and responsive behavior

Appearance choice is dark/light/system, under the profile settings menu and stored per device. Dark is the initial
fallback even if browser storage is unavailable. Load the preference before styles
paint; synchronize the browser color hint from the active CSS background.

Important execution decisions belong in the main pane at every width. Operational
logs and context diagnostics stay outside the human interface. On small screens keep the composer and approval actions
reachable; do not hide them with the desktop sidebar. Focus, warning, disabled and
recovery states must work in both modes and under reduced motion.

## References

- [Codex source observations](../../docs/plans/codex-ui/000_source_research.md)
- [Shared UI plan](../../docs/plans/codex-ui/001_ui_plan.md)
- [Conversation delivery](../../docs/plans/codex-ui/002_conversation_delivery.md)
- [Electron and web stack](../../docs/plans/codex-ui/004_electron_stack.md)
- [Codex design matching rules](../../docs/plans/codex-ui/005_codex_design_language.md)
- [Messenger-style agent list and mobile navigation](../../docs/plans/codex-ui/006_agent_list_mobile.md)
- [Agent and Codex task column comparison](../../docs/plans/codex-ui/007_sidebar_comparison.md)

Record observed, inferred, and measured values separately. Measure shared Codex
elements at a known viewport and scale. Agent-list density and navigation follow
the later messenger/mobile feedback rather than Codex session-tree dimensions.

## Activity and conversation

Show user messages and committed replies. Casual conversation supports short successive
messages with new user input changing only unpublished candidates. Long explanations
and artifacts retain their complete format, with a brief explanation of the result's
construction when useful; explicit artifact-only requests take precedence. Keep tool
rows, thinking, pre-tool commentary and operational inspectors out of ordinary chat.
Result panels contain user-facing artifacts, summaries and required actions.
Requested code in actual answers remains readable.
The original `l.` above the composer moves gently only during connected work.
A few words identify the real operation and a short target where available; elapsed
time comes from the durable request/job start. No random quips, fabricated phases or
ETA. Unknown operations use a neutral fallback. Paused/approval/offline states stop
motion; idle removes the line. Reduced motion keeps the label without animation.
Required approvals keep the action, target, exact input disclosure and allow/deny.
Active worker tasks retain Stop and required questions; their logs belong to the agent.
Normal replies have no repetitive sender headers or success/footer badges. Recovery
actions appear only on messages that need them. Mobile keeps one header and composer.

## Navigation and settings

The primary list contains agent photos, names, recent public-message previews and
needed unread/action indicators. Selecting a row resumes its persistent conversation
without moving the row. Show operational tasks in a separate list with an explicit
owner filter. Normal desktop windows switch between agent/task lists in one column;
wide windows can open a second task column explicitly. Do not use an expanded tree
inside each agent row or permanent top/bottom list split as the default.

Mobile starts with a full-screen list and real Agent, Tasks and Settings destinations.
Opening a conversation uses the full screen with a back button and composer; hide
root navigation there. Returning restores the source list, search and scroll position.
Direct links and app resume preserve the actual destination. Desktop profile menus
open upward with Settings and Keyboard Shortcuts. Chat headers contain no theme
switch or ambiguous app menu. Short action sheets and menus restore focus safely.

Settings group appearance, chat text size, send shortcut and installation/update.
Controls apply immediately. Installation help expands only when needed, and update
failures provide retry. Avoid placeholder account/usage/logout/fleet controls. Device
preferences and browser installation UI are separate from shared assistant state so
Electron clients can use their platform settings and distribution mechanisms.

## Layout adjustments

Desktop list widths are adjusted at their dividers with pointer and keyboard controls
and saved per device. Collapse the extra task column when minimum content width
cannot be preserved; retain task selection and list positions. Mobile uses full-screen
list-to-conversation navigation. Composer
height follows content; long drafts expose a temporary expand/reduce action. Bound
height by the visible viewport and fit complete text rows. Preserve draft/selection,
and keep Stop and required approvals reachable. Installation/update descriptions
explain the web-app benefit and the explicit apply/reload behavior only in settings.
