import type {
	AgentInput,
	AgentProfile,
	Dynamics,
} from "../../lina-core/src/agents/types.ts";
import { agentRequest, createAgentEditor } from "./agent-editor.ts";
import { createTemplatePicker } from "./agent-templates.ts";
import { createConversationEditor } from "./conversation-editor.ts";
import { displayName } from "./intro-model.ts";
import {
	createMindView,
	type MindResponse,
	processingPresentation,
	recordPresentation,
} from "./mind-view.ts";
import { element, setText } from "./render.ts";

type Summary = AgentProfile & { state: string; dynamics: Dynamics };
export function createAgents(currentId: string, preserve: () => boolean) {
	const list = element("other-agents", HTMLDivElement),
		primary = element("open-lina", HTMLButtonElement),
		menu = element("agent-actions", HTMLDivElement);
	const mind = createMindView();
	const mindDialog = element("mind-dialog", HTMLDialogElement);
	const mindStatus = element("mind-status", HTMLParagraphElement);
	const mindRecords = element("mind-records", HTMLDivElement);
	let mindAgent = "";
	let mindGeneration = 0,
		mindBusy = false;
	let mindOpener: HTMLElement | undefined;
	const renderMind = (value: MindResponse) => {
		mindRecords.replaceChildren();
		if (!value.available) {
			setText(
				mindStatus,
				value.reason === "room-not-open"
					? "이 에이전트의 방이 아직 열리지 않았습니다. 대화를 열면 마음 상태를 확인할 수 있습니다."
					: "이 에이전트는 기억 엔진을 사용하지 않습니다.",
			);
			return;
		}
		setText(
			mindStatus,
			`${value.state.agentId} · 리비전 ${value.state.revision} · ${new Date(value.state.asOf).toLocaleString()}${value.state.truncated ? " · 일부 기록만 표시됨" : ""} · ${processingPresentation(value.processing)}`,
		);
		if (!value.state.records.length) {
			const empty = document.createElement("p");
			empty.className = "mind-empty";
			empty.textContent = "아직 기록된 상태가 없습니다.";
			mindRecords.append(empty);
			return;
		}
		for (const record of value.state.records) {
			const row = document.createElement("article");
			row.className = "mind-record";
			const heading = document.createElement("strong");
			const presentation = recordPresentation(record, value.state.asOf);
			heading.textContent = `${presentation.subject} · ${presentation.kind} · ${presentation.support} · ${presentation.status}`;
			const text = document.createElement("p");
			text.textContent = record.text;
			const source = document.createElement("small");
			source.textContent = record.sources.length
				? `출처: ${record.sources.map((item) => `${item.entryId}: “${item.quote}”`).join(" · ")}`
				: "출처 없음";
			const retract = document.createElement("button");
			retract.type = "button";
			retract.className = "text-button";
			retract.textContent = "사용 중지";
			retract.hidden = !presentation.canRetract;
			retract.disabled = !presentation.canRetract;
			retract.addEventListener("click", async () => {
				if (mindBusy || !presentation.canRetract) return;
				const mine = mindGeneration;
				mindBusy = true;
				retract.disabled = true;
				try {
					const next = await mind.retract(
						mindAgent,
						record.id,
						value.state.revision,
					);
					if (next && mine === mindGeneration && mindDialog.open)
						renderMind(next);
				} catch (error) {
					if (mine !== mindGeneration || !mindDialog.open) return;
					setText(
						mindStatus,
						error instanceof Error
							? error.message
							: "상태를 바꾸지 못했습니다.",
					);
					retract.disabled = false;
				} finally {
					if (mine === mindGeneration) mindBusy = false;
				}
			});
			row.append(heading, text, source, retract);
			mindRecords.append(row);
		}
	};
	const openMind = async (id: string, opener: HTMLElement) => {
		const mine = ++mindGeneration;
		mindOpener = opener;
		mindBusy = false;
		mindAgent = id;
		setText(mindStatus, "마음 상태를 불러오는 중…");
		mindRecords.replaceChildren();
		if (!mindDialog.open) mindDialog.showModal();
		try {
			const value = await mind.load(id);
			if (value && mine === mindGeneration && mindDialog.open)
				renderMind(value);
		} catch (error) {
			if (mine !== mindGeneration || !mindDialog.open) return;
			setText(
				mindStatus,
				error instanceof Error
					? error.message
					: "마음 상태를 불러오지 못했습니다.",
			);
		}
	};
	mindDialog.addEventListener("close", () => {
		mindGeneration++;
		mind.close();
		mindBusy = false;
		if (mindOpener?.isConnected) mindOpener.focus();
	});
	const retryMind = document.createElement("button");
	retryMind.type = "button";
	retryMind.className = "text-button";
	retryMind.textContent = "새로 고침";
	retryMind.addEventListener("click", () => {
		if (!mindBusy) void openMind(mindAgent, mindOpener ?? retryMind);
	});
	mindStatus.after(retryMind);
	const retractHint = document.createElement("p");
	retractHint.className = "agent-hint";
	retractHint.textContent =
		"사용 중지는 앞으로 이 기록을 참고하지 않도록 합니다. 원문이나 저장 기록을 물리적으로 삭제하지 않습니다.";
	mindRecords.before(retractHint);
	for (const button of mindDialog.querySelectorAll("[data-close]"))
		button.addEventListener("click", () => mindDialog.close());
	let agents: Summary[] = [],
		signature = "",
		selectedId = currentId,
		anchor: HTMLElement = primary;
	const navigate = (id: string) => {
		if (id === currentId) {
			element("message", HTMLTextAreaElement).focus();
			return;
		}
		if (!preserve()) return;
		const target = `/?agent=${encodeURIComponent(id)}`;
		if (id !== "lina") {
			void agentRequest(`/api/agents/${id}/intro`)
				.then((value) => {
					const state = value as { room?: { id: string; status: string } };
					location.assign(
						state.room && state.room.status !== "done"
							? `/?onboarding=${state.room.id}`
							: target,
					);
				})
				.catch(() => location.assign(target));
		} else location.assign(target);
	};
	const conversationEditor = createConversationEditor();
	const editor = createAgentEditor(
		() => void refresh(),
		{},
		(id, from) => {
			if (from instanceof HTMLElement) conversationEditor.open(id, from);
		},
		(agentId, opener) => {
			document.dispatchEvent(
				new CustomEvent("lina:model-settings", { detail: { agentId, opener } }),
			);
		},
	);
	const openMenu = (id: string, element: HTMLElement) => {
		selectedId = id;
		const drawer = document.getElementById("sidebar-drawer");
		if (drawer instanceof HTMLDialogElement && drawer.open) drawer.close();
		anchor =
			window.innerWidth < 768
				? (document.getElementById("open-sidebar") as HTMLElement)
				: element;
		const r = element.getBoundingClientRect();
		menu.hidden = false;
		menu.style.left = `${Math.min(r.right, window.innerWidth - 180)}px`;
		menu.style.top = `${Math.min(r.top, window.innerHeight - 100)}px`;
		menu.querySelector<HTMLButtonElement>("button")?.focus();
	};
	element("edit-agent", HTMLButtonElement).addEventListener("click", () => {
		menu.hidden = true;
		void editor.open(selectedId, anchor);
	});
	element("open-mind", HTMLButtonElement).addEventListener("click", () => {
		menu.hidden = true;
		void openMind(selectedId, anchor);
	});
	menu.addEventListener("keydown", (event) => {
		if (event.key === "Escape") {
			event.preventDefault();
			menu.hidden = true;
			anchor.focus();
		}
	});
	document.addEventListener("pointerdown", (event) => {
		if (event.target instanceof Node && !menu.contains(event.target))
			menu.hidden = true;
	});
	const avatar = (profile: AgentProfile) => {
		const value = document.createElement("span");
		value.className = "avatar";
		if (profile.avatarId) {
			const img = document.createElement("img");
			img.src = `/api/avatars/${profile.avatarId}`;
			img.alt = "";
			value.append(img);
		} else value.textContent = profile.name.slice(0, 1);
		return value;
	};
	primary.addEventListener("contextmenu", (event) => {
		event.preventDefault();
		openMenu(currentId, primary);
	});
	element("current-agent-settings", HTMLButtonElement).addEventListener(
		"click",
		(event) => openMenu(currentId, event.currentTarget as HTMLElement),
	);
	const templates = createTemplatePicker(preserve);
	element("add-agent", HTMLButtonElement).addEventListener("click", (event) => {
		if (preserve()) templates.open(event.currentTarget as HTMLButtonElement);
	});
	async function refresh() {
		try {
			const data = (await agentRequest("/api/agents")) as {
				agents: Summary[];
				presets: AgentInput[];
			};
			agents = data.agents;
			const current = agents.find((a) => a.id === currentId);
			if (current) {
				document.title = `${displayName(current.name)} · Lina`;
				setText(
					element("chat-agent-name", HTMLElement),
					displayName(current.name),
				);
				setText(
					primary.querySelector("strong") ?? primary,
					displayName(current.name),
				);
				const old = primary.querySelector(".avatar");
				if (old) old.replaceWith(avatar(current));
				primary.setAttribute("aria-label", `${current.name} 대화`);
			}
			const next = JSON.stringify(
				agents.map((a) => [a.id, a.name, a.role, a.avatarId, a.state]),
			);
			if (signature === next) return;
			signature = next;
			list.replaceChildren(
				...agents
					.filter((a) => a.id !== currentId)
					.map((profile) => {
						const row = document.createElement("div");
						row.className = "agent-row";
						const button = document.createElement("button");
						button.type = "button";
						button.className = "agent-link";
						button.setAttribute("aria-label", `${profile.name} 대화`);
						button.append(avatar(profile));
						const copy = document.createElement("span");
						copy.className = "agent-copy sidebar-label";
						const title = document.createElement("strong");
						title.textContent = displayName(profile.name);
						const sub = document.createElement("small");
						sub.textContent =
							profile.state === "running" ? "작업 중" : profile.role;
						copy.append(title, sub);
						button.append(copy);
						button.addEventListener("click", () => navigate(profile.id));
						button.addEventListener("contextmenu", (event) => {
							event.preventDefault();
							openMenu(profile.id, button);
						});
						const more = document.createElement("button");
						more.type = "button";
						more.className = "agent-more sidebar-label";
						more.textContent = "···";
						more.setAttribute("aria-label", `${profile.name} 메뉴`);
						more.addEventListener("click", () => openMenu(profile.id, more));
						row.append(button, more);
						return row;
					}),
			);
		} catch {
			/* Legacy isolated fixtures can omit management APIs. Conversation stays usable. */
		}
	}
	void refresh();
	const interval = setInterval(() => {
		if (!document.hidden) void refresh();
	}, 15000);
	window.addEventListener("pagehide", () => clearInterval(interval));
	return { refresh };
}
