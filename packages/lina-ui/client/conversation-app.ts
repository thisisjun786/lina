import { Connection } from "../../lina-client/src/connection.ts";
import { ContextModel } from "../../lina-client/src/context-model.ts";
import { browserDraftStore } from "../../lina-client/src/draft.ts";
import { DurableChatModel } from "../../lina-client/src/durable-model.ts";
import { ExecutionModel } from "../../lina-client/src/execution-model.ts";
import {
	type DesktopPlatform,
	socketUrl,
} from "../../lina-client/src/platform.ts";
import { shouldSend } from "../../lina-client/src/preferences.ts";
import type { SessionSnapshot } from "../../lina-core/src/protocol.ts";
import { createAgents } from "./agents.ts";
import { createAttachments } from "./attachments.ts";
import { createComposerSizing } from "./composer-size.ts";
import { createExecutionView } from "./execution-view.ts";
import { createNavigation } from "./navigation.ts";
import { activityStatus, elapsedText } from "./presence.ts";
import { installPwa } from "./pwa.ts";
import {
	captureReadingPosition,
	loadReadingPosition,
	type ReadingPosition,
	restoreReadingPosition,
	saveReadingPosition,
} from "./reading-position.ts";
import { PendingRecovery } from "./recovery.ts";
import { createRenderer, element, setText } from "./render.ts";
import { createSearch } from "./search-view.ts";
import { createSettings } from "./settings.ts";
import { installTasks } from "./task-view.ts";

const NAVIGATION_DRAFT_NOTICE =
	"첨부가 준비되고 초안이 저장된 뒤 이동할 수 있습니다.";

export function startConversationApp(initialNotice = "") {
	const settings = createSettings();
	const queryAgent = new URL(location.href).searchParams.get("agent") ?? "lina";
	let agentId = /^[a-z][a-z0-9-]{0,47}$/.test(queryAgent) ? queryAgent : "lina";

	let model = new DurableChatModel();
	let execution = new ExecutionModel();
	let context = new ContextModel();
	let drafts = browserDraftStore(() => window.localStorage, agentId);
	let publicSnapshot: SessionSnapshot | undefined;
	let subscribing = false;
	const input = element("message", HTMLTextAreaElement);
	const send = element("send", HTMLButtonElement);
	element("composer-model", HTMLButtonElement).addEventListener(
		"click",
		(event) =>
			settings.openForAgent(agentId, event.currentTarget as HTMLButtonElement),
	);
	const composerSizing = createComposerSizing(input);
	const notice = element("notice", HTMLDivElement);
	const reconnect = element("reconnect", HTMLButtonElement);
	const earlier = element("earlier", HTMLButtonElement);
	const latest = element("latest", HTMLButtonElement);
	let detail = initialNotice;
	const attachments = createAttachments(
		input,
		() => model.sessionId,
		() => {
			recovery.edited();
			const saved = drafts.saveDraft(attachments.port.value);
			if (saved && !attachments.blocked && detail === NAVIGATION_DRAFT_NOTICE)
				detail = "";
			update();
		},
		(message) => {
			detail = message;
			update();
		},
	);
	const textPort = attachments.port;
	const restore = (text: string): void => {
		textPort.value = text;
		recovery.edited();
		drafts.saveDraft(text);
		input.focus();
		if (text.length > 16000) detail = "메시지 길이 초과 · 최대 16,000자";
		update();
	};
	let recovery = new PendingRecovery(drafts, textPort, restore, (message) => {
		detail = message;
	});
	const render = createRenderer(
		() => model,
		restore,
		(id) => {
			const message = model.messages.find((item) => item.id === id);
			if (
				model.sessionId &&
				message?.sourceId &&
				typeof message.nextOffset === "number"
			)
				connection.command({
					type: "entry",
					sessionId: model.sessionId,
					entryId: message.sourceId,
					offset: message.nextOffset,
				});
		},
		() => model.sessionId,
	);

	const renderExecution = createExecutionView(
		() => execution,
		(frame) => connection.command(frame),
		update,
	);

	const search = createSearch((frame) => connection.command(frame));
	const tasks = installTasks({
		ownerAgentId: agentId,
		onOpen: (id) => renderNavigation.taskOpened(id),
		onShowList: () => renderNavigation.taskClosed(),
	});
	void tasks.refresh();
	const readingPositions = new Map<string, ReadingPosition>();
	const rememberPosition = () => {
		if (
			!model.sessionId ||
			!element("conversation-scroll", HTMLDivElement).clientHeight
		)
			return;
		const position = captureReadingPosition();
		readingPositions.set(`${agentId}:${model.sessionId}`, position);
		saveReadingPosition(agentId, model.sessionId, position);
	};
	const preserve = () => {
		if (
			attachments.blocked ||
			!tasks.canLeave() ||
			(textPort.value && !drafts.saveDraft(textPort.value))
		) {
			detail = NAVIGATION_DRAFT_NOTICE;
			update();
			return false;
		}
		rememberPosition();
		if (detail === NAVIGATION_DRAFT_NOTICE) detail = "";
		return true;
	};
	const views = new Map<
		string,
		{
			model: DurableChatModel;
			execution: ExecutionModel;
			context: ContextModel;
			position: ReadingPosition;
			selection: [number, number];
		}
	>();
	let pendingPosition: ReadingPosition | undefined;
	let lastHistoryCursor: number | null = null;
	let restoreSession: string | undefined;
	const agents = createAgents(agentId, preserve, (id) => {
		renderNavigation.navigate(id);
	});
	const activate = (id: string) => {
		if (id === agentId) return true;
		connection.stop();
		views.set(agentId, {
			model,
			execution,
			context,
			position: element("conversation-scroll", HTMLDivElement).clientHeight
				? captureReadingPosition()
				: ((model.sessionId
						? (readingPositions.get(`${agentId}:${model.sessionId}`) ??
							loadReadingPosition(agentId, model.sessionId))
						: undefined) ?? { id: null, offset: 0, bottom: true }),
			selection: [input.selectionStart, input.selectionEnd],
		});
		agentId = id;
		publicSnapshot = undefined;
		lastHistoryCursor = null;
		restoreSession = undefined;
		const saved = views.get(id);
		model = saved?.model ?? new DurableChatModel();
		execution = saved?.execution ?? new ExecutionModel();
		context = saved?.context ?? new ContextModel();
		subscribing = false;
		detail = "";
		drafts = browserDraftStore(() => window.localStorage, id);
		recovery = new PendingRecovery(drafts, textPort, restore, (message) => {
			detail = message;
		});
		input.setSelectionRange(
			...(saved?.selection ?? [input.value.length, input.value.length]),
		);
		pendingPosition = saved?.position;
		search.connect(false, undefined);
		element("search-dialog", HTMLDialogElement).close();
		agents.setCurrent(id);
		void tasks.setOwner(id);
		connection = makeConnection();
		update();
		if (pendingPosition && restoreReadingPosition(pendingPosition))
			pendingPosition = undefined;
		connection.connect();
		return true;
	};
	const renderNavigation = createNavigation(
		settings,
		(opener) => search.open(opener),
		{
			activate,
			cancelSelection: () => agents.cancelNavigation(),
			preserve,
			changed: () => update(),
			openTask: (id) => {
				void tasks.open(id);
			},
			closeTask: () => tasks.closeDetail(),
			showTasks: () => {
				void tasks.refresh();
			},
		},
	);

	const presence = element("presence", HTMLDivElement);
	const presenceLabel = element("presence-label", HTMLSpanElement);
	const elapsed = element("presence-elapsed", HTMLSpanElement);
	let elapsedTimer: ReturnType<typeof setTimeout> | undefined;
	function renderPresence(): void {
		if (elapsedTimer) clearTimeout(elapsedTimer);
		const status = activityStatus({
			connected: model.connected,
			running: model.running,
			pending: model.pendingId !== undefined,
			requestStartedAt: model.requestStartedAt(
				execution.state?.cancelRequestId,
			),
			control: execution.connected ? execution.state : undefined,
			contextBusy: context.state?.busy === true,
		});
		presence.hidden = !status;
		presence.dataset["moving"] = String(status?.moving === true);
		setText(presenceLabel, status?.label ?? "");
		const time = elapsedText(status?.startedAt, Date.now());
		setText(elapsed, time ? `· ${time}` : "");
		if (status?.moving && status.startedAt)
			elapsedTimer = setTimeout(renderPresence, 1000);
	}

	function restorePosition(): void {
		if (!pendingPosition) return;
		if (restoreReadingPosition(pendingPosition)) {
			pendingPosition = undefined;
			return;
		}
		if (
			model.connected &&
			model.hasEarlier &&
			model.beforeCursor !== null &&
			model.beforeCursor !== lastHistoryCursor &&
			model.sessionId
		) {
			lastHistoryCursor = model.beforeCursor;
			connection.command({
				type: "history",
				sessionId: model.sessionId,
				before: model.beforeCursor,
			});
		}
	}

	function markVisible(): void {
		if (
			pendingPosition ||
			!publicSnapshot ||
			document.hidden ||
			model.hasNewer ||
			document.querySelector("dialog[open]")
		)
			return;
		const scroll = element("conversation-scroll", HTMLDivElement);
		if (
			!scroll.clientHeight ||
			scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight >= 80
		)
			return;
		const latest = publicSnapshot.messages.findLast(
			(item) => item.role === "assistant" || item.role === "user",
		);
		if (latest)
			agents.markVisible(agentId, publicSnapshot.sessionId, latest.seq);
	}

	function update(): void {
		composerSizing.update();
		agents.updateDraft(agentId, textPort.value);
		attachments.update(model.connected);
		render();
		renderNavigation(model);
		search.connect(model.connected, model.sessionId);
		renderExecution();
		context.connected = model.connected;
		context.running = model.running;

		element("welcome", HTMLElement).hidden =
			model.messages.length > 0 || model.running;
		send.disabled =
			!model.connected ||
			attachments.blocked ||
			!model.sessionId ||
			model.pendingId !== undefined ||
			execution.state?.cancelling === true ||
			context.state?.busy === true ||
			textPort.value.length > 16000 ||
			textPort.value.trim().length === 0;
		const state = element("connection-status", HTMLSpanElement);
		setText(state, model.connected ? "연결됨" : "연결 대기");
		state.hidden = model.connected;
		renderPresence();
		requestAnimationFrame(() => {
			restorePosition();
			markVisible();
		});
		state.className = `connection-status${model.connected ? " online" : ""}`;
		element("agent-dot", HTMLSpanElement).className =
			`agent-dot${model.connected ? " online" : ""}`;
		reconnect.hidden = model.connected;
		const shownDetail =
			textPort.value.length > 16000
				? "메시지 길이 초과 · 최대 16,000자"
				: detail;
		notice.hidden = shownDetail.length === 0;
		setText(notice, shownDetail);
		earlier.hidden = !model.hasEarlier;
		earlier.disabled = !model.connected;
		latest.hidden = !model.hasNewer;
		latest.disabled = !model.connected;
	}

	const makeConnection = () =>
		new Connection(
			socketUrl(
				location.origin,
				`/ws${agentId === "lina" ? "" : `?agent=${agentId}`}`,
			),
			{
				frame(frame) {
					if (frame.type === "agent-status" && !subscribing) {
						subscribing = true;
						connection.command({ type: "subscribe", version: 2 });
					}
					search.receive(frame);
					const reading = captureReadingPosition();
					if (
						!pendingPosition &&
						model.messages.length &&
						!reading.bottom &&
						element("conversation-scroll", HTMLDivElement).clientHeight &&
						["snapshot", "history", "entry-text"].includes(frame.type)
					)
						pendingPosition = reading;
					const previousSession = model.sessionId;
					model.receive(frame);
					if (
						frame.type === "snapshot" &&
						previousSession &&
						previousSession !== frame.snapshot.sessionId
					)
						pendingPosition = undefined;
					if (
						frame.type === "snapshot" &&
						restoreSession !== frame.snapshot.sessionId
					) {
						restoreSession = frame.snapshot.sessionId;
						pendingPosition =
							pendingPosition ?? loadReadingPosition(agentId, restoreSession);
					}
					if (frame.type === "snapshot") {
						publicSnapshot = frame.snapshot;
						agents.updateSnapshot(frame.snapshot);
					}
					if (frame.type === "snapshot") context.bindSession(model.sessionId);
					if (frame.type === "context-state" || frame.type === "context-error")
						context.receive(frame);
					if (frame.type === "snapshot") execution.bindSession(model.sessionId);
					if (frame.type === "control-state" || frame.type === "control-error")
						execution.receive(frame, model.sessionId);
					if (frame.type === "snapshot") detail = "";
					if (frame.type === "control-state" && publicSnapshot)
						agents.updateSnapshot(
							publicSnapshot,
							frame.state.approvals.filter((item) => item.state === "pending")
								.length,
						);
					recovery.receive(frame, model.sessionId);
					update();
					if (pendingPosition && restoreReadingPosition(pendingPosition))
						pendingPosition = undefined;
				},
				disconnected() {
					subscribing = false;
					model.disconnect();
					execution.disconnect();
					context.disconnect();
					recovery.disconnected();
					update();
				},
				notice(message) {
					detail = message;
					update();
				},
			},
		);

	let connection = makeConnection();
	element("conversation-scroll", HTMLDivElement).addEventListener(
		"scroll",
		() => {
			markVisible();
			if (
				!pendingPosition &&
				model.sessionId &&
				element("conversation-scroll", HTMLDivElement).clientHeight
			)
				rememberPosition();
		},
	);
	document.addEventListener("visibilitychange", markVisible);
	renderNavigation.start();
	const resizeViewport = () => {
		document.documentElement.style.setProperty(
			"--visible-height",
			`${window.visualViewport?.height ?? window.innerHeight}px`,
		);
	};
	window.visualViewport?.addEventListener("resize", resizeViewport);
	resizeViewport();
	element("composer", HTMLFormElement).addEventListener("submit", (event) => {
		event.preventDefault();
		const text = textPort.value.trim();
		if (send.disabled || !model.sessionId) return;
		const request = recovery.prepare(text, model.sessionId);
		if (!request) {
			update();
			return;
		}
		const { id } = request;
		if (!model.send(id, text)) return;
		recovery.sent(request);
		textPort.value = "";
		drafts.saveDraft("");
		if (
			!connection.send({ type: "chat", sessionId: model.sessionId, id, text })
		) {
			model.disconnect();
			textPort.value = text;
			drafts.saveDraft(text);
		}
		update();
		input.focus();
	});
	input.addEventListener("input", () => {
		recovery.edited();
		drafts.saveDraft(textPort.value);
		update();
	});
	earlier.addEventListener("click", () => {
		if (model.sessionId && model.beforeCursor !== null)
			connection.command({
				type: "history",
				sessionId: model.sessionId,
				before: model.beforeCursor,
			});
	});
	latest.addEventListener("click", () => {
		pendingPosition = undefined;
		lastHistoryCursor = null;
		model.showLatest();
		connection.command({ type: "subscribe", version: 2 });
		const scroll = element("conversation-scroll", HTMLDivElement);
		scroll.scrollTop = scroll.scrollHeight;
	});
	input.addEventListener("keydown", (event) => {
		if (!shouldSend(event, settings.preferences.sendKey)) return;
		event.preventDefault();
		if (!send.disabled) element("composer", HTMLFormElement).requestSubmit();
	});
	for (const button of document.querySelectorAll<HTMLButtonElement>(
		"[data-prompt]",
	)) {
		button.addEventListener("click", () =>
			restore(button.getAttribute("data-prompt") ?? ""),
		);
	}
	reconnect.addEventListener("click", () => {
		detail = "";
		connection.connect();
	});
	window.addEventListener("beforeunload", (event) => {
		if (!preserve()) {
			event.preventDefault();
			event.returnValue = "";
		}
	});
	window.addEventListener("pagehide", () => {
		connection.stop();
		if (elapsedTimer) clearTimeout(elapsedTimer);
		tasks.close();
	});
	window.addEventListener("pageshow", (event) => {
		if (event.persisted) connection.resume();
	});
	connection.connect();

	const desktop = (window as Window & { linaDesktop?: DesktopPlatform })
		.linaDesktop;
	if (desktop?.platform !== "desktop")
		installPwa(
			() => drafts,
			() => textPort.value,
		);
	else
		element("install-heading", HTMLElement)
			.closest("section")
			?.setAttribute("hidden", "");
	window.addEventListener("offline", () => {
		connection.connect();
		update();
	});
	window.addEventListener("online", () => {
		connection.connect();
		update();
	});
}
