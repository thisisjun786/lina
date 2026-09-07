import { createAgents } from "./agents.ts";
import { createAttachments } from "./attachments.ts";
import { createComposerSizing } from "./composer-size.ts";
import { Connection } from "./connection.ts";
import { ContextModel } from "./context-model.ts";
import { browserDraftStore } from "./draft.ts";
import { DurableChatModel } from "./durable-model.ts";
import { ExecutionModel } from "./execution-model.ts";
import { createExecutionView } from "./execution-view.ts";
import { createNavigation } from "./navigation.ts";
import { shouldSend } from "./preferences.ts";
import { activityStatus, elapsedText } from "./presence.ts";
import { installPwa } from "./pwa.ts";
import { PendingRecovery } from "./recovery.ts";
import { createRenderer, element, setText } from "./render.ts";
import { createSearch } from "./search-view.ts";
import { createSettings } from "./settings.ts";
import { installTasks } from "./task-view.ts";

export function startConversationApp(initialNotice = "") {
	const settings = createSettings();
	const queryAgent = new URL(location.href).searchParams.get("agent") ?? "lina";
	const agentId = /^[a-z][a-z0-9-]{0,47}$/.test(queryAgent)
		? queryAgent
		: "lina";

	const model = new DurableChatModel();
	const execution = new ExecutionModel();
	const context = new ContextModel();
	const drafts = browserDraftStore(() => window.localStorage, agentId);
	let subscribing = false;
	const input = element("message", HTMLTextAreaElement);
	const send = element("send", HTMLButtonElement);
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
			drafts.saveDraft(attachments.port.value);
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
	const recovery = new PendingRecovery(drafts, textPort, restore, (message) => {
		detail = message;
	});
	const render = createRenderer(
		model,
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
		execution,
		(frame) => connection.command(frame),
		update,
	);

	const search = createSearch((frame) => connection.command(frame));
	const tasks = installTasks({ ownerAgentId: agentId });
	void tasks.refresh();
	createAgents(agentId, () => {
		if (
			attachments.busy ||
			(textPort.value && !drafts.saveDraft(textPort.value))
		) {
			detail = "초안을 저장한 뒤 에이전트를 바꿔주세요.";
			update();
			return false;
		}
		return true;
	});
	const renderNavigation = createNavigation(settings, (opener) =>
		search.open(opener),
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

	function update(): void {
		composerSizing.update();
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
			attachments.busy ||
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

	const connection = new Connection(
		`${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}/ws${agentId === "lina" ? "" : `?agent=${agentId}`}`,
		{
			frame(frame) {
				if (frame.type === "agent-status" && !subscribing) {
					subscribing = true;
					connection.command({ type: "subscribe", version: 2 });
				}
				search.receive(frame);
				model.receive(frame);
				if (frame.type === "snapshot") context.bindSession(model.sessionId);
				if (frame.type === "context-state" || frame.type === "context-error")
					context.receive(frame);
				if (frame.type === "snapshot") execution.bindSession(model.sessionId);
				if (frame.type === "control-state" || frame.type === "control-error")
					execution.receive(frame, model.sessionId);
				if (frame.type === "snapshot") detail = "";
				recovery.receive(frame, model.sessionId);
				update();
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
	window.addEventListener("pagehide", () => {
		connection.stop();
		if (elapsedTimer) clearTimeout(elapsedTimer);
		tasks.close();
	});
	window.addEventListener("pageshow", (event) => {
		if (event.persisted) connection.resume();
	});
	connection.connect();

	installPwa(drafts, () => textPort.value);
	window.addEventListener("offline", () => {
		connection.connect();
		update();
	});
	window.addEventListener("online", () => {
		connection.connect();
		update();
	});
}
