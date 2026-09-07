import type { AgentInput } from "../../lina-core/src/agents/types.ts";
import { introRequest } from "./intro-api.ts";
import {
	createChatAgent,
	createTemplateAgent,
} from "./onboarding-navigation.ts";

export function domainTemplates(presets: AgentInput[]): AgentInput[] {
	return presets.filter((p) => p.id !== "lina");
}

/** One picker for later additions; nothing is created merely by opening it. */
export function createTemplatePicker(preserve: () => boolean) {
	const dialog = document.createElement("dialog");
	dialog.id = "template-dialog";
	dialog.className = "settings-dialog template-dialog";
	dialog.setAttribute("aria-labelledby", "template-heading");
	const header = document.createElement("header");
	header.className = "dialog-header";
	const title = document.createElement("h2");
	title.id = "template-heading";
	title.textContent = "에이전트 추가";
	const close = document.createElement("button");
	close.type = "button";
	close.className = "icon-button";
	close.textContent = "×";
	close.setAttribute("aria-label", "에이전트 추가 닫기");
	header.append(title, close);
	const content = document.createElement("div");
	content.className = "template-content";
	const description = document.createElement("p");
	description.className = "template-description";
	description.textContent =
		"리나와 대화하며 새 에이전트를 만들어요. 맡길 분야를 고르면 기본 성격과 역할에서 시작할 수 있어요.";
	const custom = document.createElement("button");
	custom.type = "button";
	custom.className = "secondary-button";
	custom.id = "template-custom";
	custom.textContent = "처음부터 직접 만들기";
	const status = document.createElement("p");
	status.className = "settings-status";
	status.setAttribute("role", "status");
	const list = document.createElement("div");
	list.className = "template-list";
	const retry = document.createElement("button");
	retry.type = "button";
	retry.className = "text-button";
	retry.textContent = "다시 불러오기";
	retry.hidden = true;
	content.append(description, custom, status, list, retry);
	dialog.append(header, content);
	document.body.append(dialog);
	let opener: HTMLElement | undefined,
		busy = false,
		generation = 0;
	function disabled(value: boolean) {
		for (const b of content.querySelectorAll("button")) b.disabled = value;
	}
	async function create(templateId?: string) {
		if (busy || !preserve()) return;
		busy = true;
		disabled(true);
		status.textContent = "대화를 준비하고 있어요.";
		try {
			if (templateId) await createTemplateAgent(templateId);
			else await createChatAgent();
		} catch (error) {
			status.textContent =
				error instanceof Error
					? error.message
					: "에이전트를 만들지 못했습니다. 다시 시도해주세요.";
		} finally {
			busy = false;
			disabled(false);
		}
	}
	async function load() {
		const mine = ++generation;
		status.textContent = "템플릿을 불러오는 중…";
		retry.hidden = true;
		list.replaceChildren();
		try {
			const value = (await introRequest("/api/agents")) as {
				presets: AgentInput[];
			};
			if (mine !== generation || !dialog.open) return;
			if (!Array.isArray(value.presets))
				throw Error("템플릿 목록을 불러오지 못했습니다.");
			for (const p of domainTemplates(value.presets)) {
				const b = document.createElement("button");
				b.type = "button";
				b.className = "template-choice";
				b.dataset["templateId"] = p.id;
				const role = document.createElement("strong");
				role.textContent = p.role;
				const name = document.createElement("span");
				name.textContent = `${p.name} 템플릿`;
				b.append(role, name);
				b.addEventListener("click", () => void create(p.id));
				list.append(b);
			}
			status.textContent = list.children.length
				? ""
				: "사용 가능한 도메인 템플릿이 없습니다. 직접 만들 수 있어요.";
			disabled(busy);
		} catch (error) {
			if (mine !== generation || !dialog.open) return;
			status.textContent =
				error instanceof Error
					? error.message
					: "템플릿을 불러오지 못했습니다.";
			retry.hidden = false;
		}
	}
	custom.addEventListener("click", () => void create());
	retry.addEventListener("click", () => void load());
	close.addEventListener("click", () => {
		if (!busy) dialog.close();
	});
	dialog.addEventListener("cancel", (e) => {
		if (busy) e.preventDefault();
	});
	dialog.addEventListener("close", () => {
		generation++;
		if (opener?.getClientRects().length) opener.focus();
		else document.getElementById("open-sidebar")?.focus();
	});
	return {
		open(from: HTMLElement) {
			if (busy) return;
			opener = from;
			const drawer = document.getElementById("sidebar-drawer");
			if (drawer instanceof HTMLDialogElement && drawer.open) drawer.close();
			if (!dialog.open) dialog.showModal();
			void load();
		},
	};
}
