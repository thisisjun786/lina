import { createElement } from "react";
import {
	type AgentConversationSummary,
	AgentListModel,
	type AgentListProfile,
	summaryFromSnapshot,
} from "../../lina-client/src/agent-list.ts";
import { browserDraftStore } from "../../lina-client/src/draft.ts";
import type { SessionSnapshot } from "../../lina-core/src/protocol.ts";
import { agentRequest, createAgentEditor } from "./agent-editor.ts";
import { createAgentListView } from "./agent-list.ts";
import { createTemplatePicker } from "./agent-templates.ts";
import { createActionMenu } from "./components/action-menu.tsx";
import { MindIcon, SettingsIcon } from "./components/icons.tsx";
import { createConversationEditor } from "./conversation-editor.ts";
import { displayName } from "./intro-model.ts";
import {
	createMindView,
	type MindResponse,
	processingPresentation,
	recordPresentation,
} from "./mind-view.ts";
import { element, setText } from "./render.ts";

export function createAgents(
	initialId: string,
	preserve: () => boolean,
	onSelect?: (agentId: string) => void | Promise<void>,
) {
	let currentId = initialId;
	const list = element("other-agents", HTMLDivElement),
		primary = document.getElementById("open-lina");
	const status = element("agent-list-status", HTMLElement);
	const filter = element("agent-filter", HTMLInputElement);
	const model = new AgentListModel(currentId, {
		getItem: (key) => localStorage.getItem(key),
		setItem: (key, value) => localStorage.setItem(key, value),
	});
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
	let agents: AgentListProfile[] = [],
		selectedId = currentId;
	let navigationGeneration = 0;
	const navigate = async (id: string) => {
		if (id !== currentId && !preserve()) return;
		const mine = ++navigationGeneration;
		try {
			if (id !== "lina" && id !== currentId) {
				const state = (await agentRequest(
					`/api/agents/${encodeURIComponent(id)}/intro`,
				)) as { room?: { id: string; status: string } };
				if (mine !== navigationGeneration) return;
				if (state.room && state.room.status !== "done") {
					location.assign(`/?onboarding=${encodeURIComponent(state.room.id)}`);
					return;
				}
			}
			if (onSelect) await onSelect(id);
			else if (id !== currentId)
				location.assign(`/?agent=${encodeURIComponent(id)}`);
		} catch {
			if (mine !== navigationGeneration) return;
			renderList.notice("대화를 열지 못했어요. 에이전트를 다시 선택해주세요.");
		}
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
	const menu = createActionMenu({
		id: "agent-actions",
		label: "에이전트 메뉴",
		align: "end",
		items: [
			{
				id: "edit-agent",
				label: "프로필 및 설정",
				icon: createElement(SettingsIcon),
				run: (opener) => void editor.open(selectedId, opener),
			},
			{
				id: "open-mind",
				label: "마음 상태 보기",
				icon: createElement(MindIcon),
				run: (opener) => void openMind(selectedId, opener),
			},
		],
	});
	const closeMenu = () => menu.close();
	const openMenu = (id: string, opener: HTMLElement) => {
		selectedId = id;
		menu.open(opener);
	};
	window.addEventListener("resize", closeMenu);
	primary?.addEventListener("click", () => void navigate(currentId));
	primary?.addEventListener("contextmenu", (event) => {
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
	const renderList = createAgentListView(model, list, status, {
		select: (id) => void navigate(id),
		menu: openMenu,
		retry: () => void refresh(),
	});
	const updateLabels = () => {
		const current = agents.find((agent) => agent.id === currentId);
		if (!current) return;
		document.title = `${displayName(current.name)} · Lina`;
		setText(element("chat-agent-name", HTMLElement), displayName(current.name));
		element("current-agent-settings", HTMLButtonElement).setAttribute(
			"aria-label",
			`${current.name} 프로필과 설정`,
		);
	};
	const loadedDrafts = new Set<string>();
	let inFlight: Promise<void> | undefined;
	function refresh(): Promise<void> {
		if (inFlight) return inFlight;
		inFlight = (async () => {
			try {
				const data = (await agentRequest("/api/agents")) as {
					agents: AgentListProfile[];
					summaries?: AgentConversationSummary[];
				};
				agents = data.agents;
				model.replace(agents);
				for (const profile of agents) {
					if (loadedDrafts.has(profile.id)) continue;
					model.setDraft(
						profile.id,
						browserDraftStore(() => localStorage, profile.id).draft(),
					);
					loadedDrafts.add(profile.id);
				}
				if (data.summaries)
					for (const summary of data.summaries) model.updateSummary(summary);
				else model.summariesFailed();
				updateLabels();
			} catch {
				model.fail();
			}
			renderList();
		})().finally(() => {
			inFlight = undefined;
		});
		return inFlight;
	}
	filter.addEventListener("input", () => {
		model.setFilter(filter.value);
		renderList();
	});
	const updateDraft = (id: string, text: string) => {
		loadedDrafts.add(id);
		model.setDraft(id, text);
		renderList();
	};
	document.getElementById("message")?.addEventListener("input", (event) => {
		if (event.target instanceof HTMLTextAreaElement)
			updateDraft(currentId, event.target.value);
	});
	window.addEventListener("storage", () => {
		for (const profile of agents)
			model.setDraft(
				profile.id,
				browserDraftStore(() => localStorage, profile.id).draft(),
			);
		renderList();
	});
	renderList();
	void refresh();
	const interval = setInterval(() => {
		if (!document.hidden) void refresh();
	}, 15000);
	window.addEventListener("pagehide", () => clearInterval(interval));
	return {
		refresh,
		cancelNavigation() {
			navigationGeneration++;
		},
		updateDraft,
		setCurrent(id: string) {
			navigationGeneration++;
			currentId = id;
			model.setCurrent(id);
			closeMenu();
			updateLabels();
			renderList();
		},
		updateSummary(summary: AgentConversationSummary) {
			model.updateSummary(summary);
			renderList();
		},
		updateSnapshot(snapshot: SessionSnapshot, confirmationCount?: number) {
			const previous = model.summary(snapshot.botId);
			model.updateSummary(
				summaryFromSnapshot(
					snapshot,
					confirmationCount ??
						(previous?.sessionId === snapshot.sessionId
							? previous.confirmationCount
							: null),
				),
			);
			renderList();
		},
		markVisible(agentId: string, sessionId: string, seq: number) {
			if (!document.hidden) model.markVisible(agentId, sessionId, seq);
			renderList();
		},
	};
}
