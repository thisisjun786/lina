import { createComposerSizing } from "./composer-size.ts";
import { introRequest, isOnboardingAbort } from "./intro-api.ts";
import { checkIntroConnection } from "./intro-connection.ts";
import {
	bubblesFromTurns,
	clearBirthId,
	ordinaryAgentUrl,
	parseChooseResult,
	parseEntry,
	parseSnapshot,
	persistBirthId,
	readIntroDraft,
	saveIntroDraft,
	shouldStartOpening,
} from "./intro-model.ts";
import type {
	InterviewMode,
	IntroEntry,
	IntroSnapshot,
	IntroTurn,
} from "./intro-types.ts";
import {
	type IntroDocument,
	type IntroNode,
	renderMode,
	renderPanel,
	renderProgress,
	renderSummary,
	renderTranscript,
} from "./intro-view.ts";
import { createChatAgent } from "./onboarding-navigation.ts";
import { shouldSend } from "./preferences.ts";
import { element, setText } from "./render.ts";
import { createSettings } from "./settings.ts";

export async function startIntroApp(intent: {
	intent: "user" | "room";
	roomId?: string;
}) {
	document.body.classList.add("intro-active");
	const settings = createSettings();
	const input = element("message", HTMLTextAreaElement),
		send = element("send", HTMLButtonElement),
		composer = element("composer", HTMLFormElement),
		messages = element("messages", HTMLDivElement),
		scroll = element("conversation-scroll", HTMLDivElement),
		notice = element("notice", HTMLDivElement);
	const sizing = createComposerSizing(input);
	input.maxLength = 4000;
	input.placeholder = "편하게 이야기해 주세요";
	const doc = document as unknown as IntroDocument;
	const node = (element: HTMLElement) => element as unknown as IntroNode;
	const make = (tag: string, className: string, text = "") => {
		const e = document.createElement(tag);
		e.className = className;
		e.textContent = text;
		return e;
	};
	const bar = make("section", "intro-toolbar"),
		label = make("p", "intro-kicker", "처음 나누는 대화"),
		progress = make("p", "intro-progress"),
		modes = make("div", "intro-modes");
	for (const [mode, title] of [
		["fast", "간단히 시작"],
		["thoughtful", "충분히 알아가기"],
	]) {
		const b = document.createElement("button");
		b.type = "button";
		b.className = "text-button";
		b.dataset["introMode"] = mode;
		b.textContent = title ?? "";
		modes.append(b);
	}
	bar.append(label, modes, progress);
	messages.before(bar);
	const summary = document.createElement("details");
	summary.className = "intro-summary";
	const heading = document.createElement("summary");
	heading.textContent = "지금까지 함께 정리한 내용";
	const userSummary = make("div", ""),
		personaSummary = make("div", "");
	summary.append(heading, userSummary, personaSummary);
	bar.append(summary);
	const setup = make("section", "intro-setup");
	setup.id = "intro-setup";
	const setupMessage = make("p", "");
	setupMessage.setAttribute("role", "status");
	const setupButton = make("button", "secondary-button", "모델 설정");
	setupButton.id = "intro-model-setup";
	setupButton.setAttribute("type", "button");
	const setupRetry = make("button", "text-button", "연결 다시 확인");
	setupRetry.id = "intro-model-retry";
	setupRetry.setAttribute("type", "button");
	setup.append(setupMessage, setupButton, setupRetry);
	bar.append(setup);
	const changes = make("div", "intro-changes"),
		panel = make("section", "intro-panel");
	panel.id = "intro-panel";
	messages.after(changes, panel);
	const stop = document.createElement("button");
	stop.type = "button";
	stop.className = "text-button";
	stop.id = "intro-stop";
	stop.textContent = "응답 멈추기";
	stop.hidden = true;
	send.before(stop);
	let state: IntroSnapshot = {
		room: null,
		turns: [],
		userRevision: 0,
		shareUser: false,
		presets: [],
		sessionId: null,
	};
	let entry: IntroEntry | null = null,
		reviewOpen = false,
		busy = false,
		closed = false,
		controller: AbortController | undefined,
		poll: ReturnType<typeof setTimeout> | undefined,
		stoppedRequestId: string | null = null,
		pendingRequestId: string | null = null;
	let localTurn: IntroTurn | null = null,
		errorText = "";
	let modelReady = false,
		connectionMessage = "모델 연결을 확인하고 있어요.",
		connectionGeneration = 0;
	function render() {
		if (closed) return;
		const room = state.room,
			pending = state.turns.some((t) => t.status === "pending"),
			active = room?.status === "active";
		setText(element("chat-agent-name", HTMLElement), "리나");
		label.textContent =
			room?.kind === "persona" ? "새 에이전트 만들기" : "처음 만나는 리나";
		document.title = `${label.textContent} · Lina`;
		setText(
			element("connection-status", HTMLSpanElement),
			busy ? "응답 준비 중" : "",
		);
		element("reconnect", HTMLButtonElement).hidden = true;
		const turns =
			localTurn &&
			!state.turns.some((t) => t.requestId === localTurn?.requestId)
				? [...state.turns, localTurn]
				: state.turns;
		renderTranscript(
			node(messages),
			doc,
			bubblesFromTurns(turns, { stoppedRequestId }),
		);
		renderSummary(node(userSummary), node(personaSummary), doc, room);
		userSummary.hidden = room?.kind !== "user";
		personaSummary.hidden = room?.kind !== "persona";
		renderProgress(
			node(progress),
			room,
			state.turns.filter((t) => t.text !== null).length,
		);
		if (room) renderMode(node(modes), room.mode);
		for (const b of modes.querySelectorAll<HTMLButtonElement>("button"))
			b.disabled = busy || pending || !active;
		renderPanel(node(panel), doc, {
			snapshot: state,
			reviewOpen,
			entry,
			busy: busy || pending,
		});
		if (reviewOpen && active) {
			const more = document.createElement("button");
			more.type = "button";
			more.className = "text-button";
			more.dataset["introAction"] = "continue";
			more.textContent = "계속 이야기하기";
			panel.append(more);
		}
		changes.replaceChildren();
		if (room?.data.summary.length) {
			const d = document.createElement("details"),
				title = document.createElement("summary");
			title.textContent = "이번 대화에서 정리한 내용";
			d.append(title);
			const ul = document.createElement("ul");
			for (const text of room.data.summary) {
				const li = document.createElement("li");
				li.textContent = text;
				ul.append(li);
			}
			d.append(ul);
			changes.append(d);
		}
		notice.hidden = !errorText;
		setText(notice, errorText);
		setup.hidden = !active || modelReady;
		setText(setupMessage, connectionMessage);
		send.disabled =
			!modelReady ||
			busy ||
			pending ||
			!active ||
			!input.value.trim() ||
			input.value.length > 4000;
		input.disabled = !active;
		composer.hidden = !!room && !active;
		stop.hidden = !controller;
		sizing.update();
	}
	const save = () => {
		if (state.room) saveIntroDraft(localStorage, state.room.id, input.value);
	};
	const goto = (url: string) => {
		save();
		location.assign(url);
	};
	async function refresh() {
		if (!state.room) return;
		const next = parseSnapshot(
			await introRequest(`/api/onboarding/rooms/${state.room.id}`),
		);
		if (closed) return;
		state = next;
		render();
		schedulePoll();
	}
	function schedulePoll() {
		if (poll) clearTimeout(poll);
		if (!closed && !busy && state.turns.some((t) => t.status === "pending"))
			poll = setTimeout(() => {
				void refresh().catch(() => {
					errorText = "연결을 확인하고 상태를 다시 불러와주세요.";
					render();
				});
			}, 1000);
	}
	async function operation(action: () => Promise<void>) {
		if (busy || closed) return;
		busy = true;
		errorText = "";
		render();
		try {
			await action();
		} catch (error) {
			if (!closed) {
				errorText =
					error instanceof Error ? error.message : "요청을 마치지 못했습니다.";
				try {
					await refresh();
				} catch {}
			}
		} finally {
			busy = false;
			render();
			schedulePoll();
		}
	}
	async function say(
		text: string | null,
		requestId: string = crypto.randomUUID(),
	) {
		if (!state.room) return;
		const room = state.room,
			original = input.value;
		await operation(async () => {
			if (!modelReady) return;
			controller = new AbortController();
			pendingRequestId = requestId;
			stoppedRequestId = null;
			localTurn = {
				id: requestId,
				requestId,
				seq: state.turns.length + 1,
				text,
				reply: null,
				status: "pending",
				attempts: 1,
				error: null,
				summary: [],
				createdAt: Date.now(),
			};
			// The server remains authoritative after failure/reload. Keep unsent text locally until acknowledged.
			render();
			scroll.scrollTop = scroll.scrollHeight;
			try {
				const next = parseSnapshot(
					await introRequest(
						`/api/agents/${room.agentId}/intro/turn`,
						"POST",
						{ roomId: room.id, revision: room.revision, requestId, text },
						controller.signal,
					),
				);
				if (closed) return;
				state = next;
				if (text !== null && input.value === original) {
					input.value = "";
					save();
				}
				localTurn = null;
			} catch (error) {
				if (isOnboardingAbort(error)) {
					stoppedRequestId = requestId;
					errorText = "응답 준비를 멈췄습니다. 대화는 그대로 남아 있어요.";
				} else
					errorText =
						error instanceof Error
							? error.message
							: "응답을 완성하지 못했습니다.";
				try {
					await refresh();
					if (state.turns.some((t) => t.requestId === requestId)) {
						localTurn = null;
						if (text !== null && input.value === original) {
							input.value = "";
							save();
						}
					} else if (localTurn)
						localTurn = {
							...localTurn,
							status: "failed",
							error: "reply_failed",
						};
				} catch {
					if (localTurn)
						localTurn = {
							...localTurn,
							status: "failed",
							error: "reply_failed",
						};
				}
				await checkConnection(false);
			} finally {
				controller = undefined;
				pendingRequestId = null;
				render();
				scroll.scrollTop = scroll.scrollHeight;
			}
		});
	}
	async function checkConnection(opening: boolean) {
		const room = state.room;
		if (room?.status !== "active" || closed) return;
		const generation = ++connectionGeneration;
		const result = await checkIntroConnection(introRequest, "lina");
		if (
			closed ||
			generation !== connectionGeneration ||
			state.room?.id !== room.id
		)
			return;
		modelReady = result.ready;
		connectionMessage = result.message;
		render();
		if (opening && modelReady && !busy && shouldStartOpening(state))
			await say(null);
	}
	setupButton.addEventListener("click", () =>
		settings.openForAgent("lina", setupButton),
	);
	setupRetry.addEventListener("click", () => void checkConnection(true));
	element("settings-dialog", HTMLDialogElement).addEventListener(
		"close",
		() => void checkConnection(true),
	);
	async function finish(skip: boolean) {
		const room = state.room;
		if (!room) return;
		const share =
			room.kind === "user"
				? true
				: (document.querySelector<HTMLInputElement>("#intro-share-user")
						?.checked ?? state.shareUser);
		await operation(async () => {
			state = parseSnapshot(
				await introRequest(`/api/agents/${room.agentId}/intro/finish`, "POST", {
					roomId: room.id,
					revision: room.revision,
					userRevision: state.userRevision,
					shareUser: share,
					skip,
				}),
			);
			reviewOpen = false;
			if (state.room?.status === "done") goto(ordinaryAgentUrl(room.agentId));
			else scroll.scrollTop = scroll.scrollHeight;
		});
	}
	async function choose(presetId: string | null) {
		const room = state.room;
		if (!room) return;
		const share =
			document.querySelector<HTMLInputElement>("#intro-share-user")?.checked ??
			false;
		const birthId = persistBirthId(localStorage, () => crypto.randomUUID());
		await operation(async () => {
			const result = parseChooseResult(
				await introRequest(`/api/agents/${room.agentId}/intro/choose`, "POST", {
					roomId: room.id,
					revision: room.revision,
					userRevision: state.userRevision,
					presetId,
					birthId,
					shareUser: share,
				}),
			);
			clearBirthId(localStorage);
			goto(result.url);
		});
	}
	async function resume() {
		const room = state.room,
			f = room?.finalization;
		if (!room || !f) return;
		await operation(async () => {
			if (f["action"] === "finish") {
				state = parseSnapshot(
					await introRequest(
						`/api/agents/${room.agentId}/intro/finish`,
						"POST",
						{
							roomId: room.id,
							revision: room.revision,
							userRevision: f["userRevision"],
							shareUser: f["shareUser"],
							skip: f["skip"],
						},
					),
				);
				if (state.room?.status === "done") goto(ordinaryAgentUrl(room.agentId));
			} else if (f["action"] === "choose") {
				const result = parseChooseResult(
					await introRequest(
						`/api/agents/${room.agentId}/intro/choose`,
						"POST",
						{
							roomId: room.id,
							revision: room.revision,
							userRevision: f["userRevision"],
							shareUser: f["shareUser"],
							presetId: f["presetId"],
							birthId: f["birthId"],
						},
					),
				);
				clearBirthId(localStorage);
				goto(result.url);
			}
		});
	}
	composer.addEventListener("submit", (e) => {
		e.preventDefault();
		if (!send.disabled) void say(input.value);
	});
	input.addEventListener("input", () => {
		save();
		render();
	});
	input.addEventListener("keydown", (e) => {
		if (shouldSend(e, settings.preferences.sendKey)) {
			e.preventDefault();
			if (!send.disabled) composer.requestSubmit();
		}
	});
	stop.addEventListener("click", () => {
		stoppedRequestId = pendingRequestId;
		controller?.abort();
	});
	modes.addEventListener("click", (event) => {
		const b = (event.target as Element).closest<HTMLButtonElement>(
			"[data-intro-mode]",
		);
		const room = state.room;
		if (!b || !room) return;
		const mode = b.dataset["introMode"] as InterviewMode;
		void operation(async () => {
			state = parseSnapshot(
				await introRequest(`/api/agents/${room.agentId}/intro/mode`, "POST", {
					roomId: room.id,
					revision: room.revision,
					mode,
				}),
			);
		});
	});
	scroll.addEventListener("click", (event) => {
		const target = (event.target as Element).closest<HTMLElement>(
			"[data-intro-action]",
		);
		if (!target) return;
		const action = target.dataset["introAction"];
		event.preventDefault();
		if (busy) return;
		if (action === "review") {
			reviewOpen = true;
			render();
			panel.scrollIntoView({ block: "nearest" });
		} else if (action === "continue") {
			reviewOpen = false;
			render();
			input.focus();
		} else if (action === "skip") void finish(true);
		else if (action === "confirm-user" || action === "confirm-persona")
			void finish(false);
		else if (action === "choose")
			void choose(target.dataset["presetId"] ?? null);
		else if (action === "choose-custom") void choose(null);
		else if (action === "retry") {
			const requestId = target.dataset["requestId"];
			const turn =
				state.turns.find((t) => t.requestId === requestId) ?? localTurn;
			if (turn) void say(turn.text, turn.requestId);
		} else if (action === "resume") void resume();
		else if (action === "reload") void operation(refresh);
		else if (action === "restart") {
			const room = state.room;
			if (room)
				void operation(async () => {
					const next = parseSnapshot(
						await introRequest(
							`/api/agents/${room.agentId}/intro/restart`,
							"POST",
							{ roomId: room.id, revision: room.revision },
						),
					);
					if (next.room) goto(`/?onboarding=${next.room.id}`);
				});
		} else if (action === "legacy")
			void operation(() => createChatAgent(target.dataset["draftId"]));
	});
	window.addEventListener("pagehide", () => {
		save();
		closed = true;
		controller?.abort();
		if (poll) clearTimeout(poll);
	});
	window.addEventListener("pageshow", (e) => {
		if (e.persisted) location.reload();
	});
	render();
	entry = parseEntry(await introRequest("/api/onboarding/entry"));
	state = parseSnapshot(
		await introRequest(
			intent.intent === "room"
				? `/api/onboarding/rooms/${intent.roomId}`
				: "/api/agents/lina/intro",
			intent.intent === "room" ? "GET" : "POST",
			intent.intent === "room"
				? undefined
				: { kind: "user", mode: "thoughtful" },
		),
	);
	if (closed) return;
	if (!state.room) throw Error("대화를 찾지 못했습니다.");
	history.replaceState(null, "", `/?onboarding=${state.room.id}`);
	input.value = readIntroDraft(localStorage, state.room.id);
	render();
	await checkConnection(true);
	schedulePoll();
}
