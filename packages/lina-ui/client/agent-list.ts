import { createElement } from "react";
import type {
	AgentListModel,
	AgentListRow,
} from "../../lina-client/src/agent-list.ts";
import {
	AgentList,
	type AgentListActions,
	AgentListStatus,
} from "./components/agent-list.tsx";
import { mountView } from "./components/mount.ts";

export function agentAvatar(
	profile: Pick<AgentListRow, "name" | "avatarId">,
): HTMLSpanElement {
	const avatar = document.createElement("span");
	avatar.className = "avatar";
	avatar.setAttribute("aria-hidden", "true");
	const fallback = () => {
		avatar.textContent = Array.from(profile.name.trim())[0] ?? "?";
	};
	fallback();
	if (profile.avatarId) {
		const img = document.createElement("img");
		img.src = `/api/avatars/${encodeURIComponent(profile.avatarId)}`;
		img.alt = "";
		img.loading = "lazy";
		img.addEventListener("error", fallback, { once: true });
		avatar.replaceChildren(img);
	}
	return avatar;
}

export function createAgentListView(
	model: AgentListModel,
	list: HTMLElement,
	status: HTMLElement,
	actions: AgentListActions,
) {
	const listView = mountView(list);
	const statusView = mountView(status);
	status.setAttribute("role", "status");
	status.setAttribute("aria-live", "polite");
	const renderStatus = (copy: string, retry: boolean) => {
		statusView.render(
			createElement(AgentListStatus, { copy, retry, onRetry: actions.retry }),
		);
		status.hidden = !copy;
	};
	const render = () => {
		const rows = model.rows();
		const filter = document.getElementById("agent-filter");
		const filtered = filter instanceof HTMLInputElement && filter.value.trim();
		const unavailable = rows.some((row) => row.summaryUnavailable);
		const copy =
			model.status === "error"
				? "에이전트 목록을 불러오지 못했어요. 다시 시도해주세요."
				: model.status === "loading"
					? "에이전트를 불러오는 중…"
					: !rows.length
						? filtered
							? "이름이나 역할이 일치하는 에이전트가 없어요."
							: "아직 에이전트가 없어요. 추가 버튼으로 시작해보세요."
						: unavailable
							? "일부 대화 요약을 새로 불러오지 못했어요."
							: "";
		listView.render(createElement(AgentList, { rows, actions }));
		renderStatus(copy, model.status === "error" || unavailable);
		list.setAttribute("aria-busy", String(model.status === "loading"));
	};
	return Object.assign(render, {
		// Transient navigation errors share React's status root. Rendering the model clears them.
		notice: (message: string) => renderStatus(message, false),
	});
}
