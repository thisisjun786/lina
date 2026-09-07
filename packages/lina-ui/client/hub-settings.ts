import { agentRequest, type RequestFn } from "./agent-editor.ts";
import type { SettingsDocument } from "./model-settings.ts";

export type HubStatus = {
	configured: boolean;
	connected: boolean;
	guiUrl: string | null;
	error: string | null;
	modelCount: number;
};

export type HubView = {
	live: boolean;
	summary: string;
	error: string;
	guiUrl: string | null;
};

function asRecord(value: unknown): Record<string, unknown> | null {
	return value !== null && typeof value === "object"
		? (value as Record<string, unknown>)
		: null;
}

export function parseHubStatus(value: unknown): HubStatus {
	const record = asRecord(value);
	if (!record) throw Error("연결 상태를 확인하지 못했습니다.");
	const configured = record["configured"];
	const connected = record["connected"];
	const modelCount = record["modelCount"];
	const guiUrl = record["guiUrl"];
	const error = record["error"];
	if (typeof configured !== "boolean" || typeof connected !== "boolean")
		throw Error("연결 상태가 올바르지 않습니다.");
	if (
		typeof modelCount !== "number" ||
		!Number.isFinite(modelCount) ||
		modelCount < 0
	)
		throw Error("연결 상태가 올바르지 않습니다.");
	if (guiUrl !== null && typeof guiUrl !== "string")
		throw Error("연결 상태가 올바르지 않습니다.");
	if (error !== null && typeof error !== "string")
		throw Error("연결 상태가 올바르지 않습니다.");
	return {
		configured,
		connected,
		guiUrl,
		error,
		modelCount: Math.floor(modelCount),
	};
}

export function safeHubGuiUrl(value: string | null): string | null {
	if (!value) return null;
	try {
		const url = new URL(value);
		if (url.protocol !== "https:") return null;
		if (url.username || url.password) return null;
		const host = url.hostname.toLowerCase();
		if (!host.endsWith(".ts.net")) return null;
		const prefix = host.slice(0, -".ts.net".length);
		if (!prefix || prefix.endsWith(".")) return null;
		return url.href;
	} catch {
		return null;
	}
}

export function hubPresentation(status: HubStatus): HubView {
	const error = status.error?.trim() ?? "";
	const live = status.configured && status.connected && error.length === 0;
	const guiUrl = safeHubGuiUrl(status.guiUrl);
	const summary = !status.configured
		? "OpenCodex가 설정되어 있지 않습니다. 서버 설정을 확인한 뒤 새로 고침하세요."
		: live
			? `연결됨 · 모델 ${status.modelCount}개`
			: status.connected
				? "연결을 확인하지 못했습니다."
				: "OpenCodex에 연결하지 못했습니다.";
	return { live, summary, error, guiUrl };
}

function browserDocument(): SettingsDocument {
	const doc = (globalThis as { document?: SettingsDocument }).document;
	if (!doc) throw Error("Hub settings require a document");
	return doc;
}

export function installHubSettings(
	dialog: { open: boolean },
	options: { onModels(): void; onChanged(): void },
	doc: SettingsDocument = browserDocument(),
	request: RequestFn = agentRequest,
) {
	const find = (id: string) => {
		const n = doc.getElementById(id);
		if (!n) throw Error(`Missing interface element: ${id}`);
		return n;
	};
	const statusNode = find("hub-status");
	const errorNode = find("hub-error");
	const summary = find("hub-summary");
	const openLink = find("hub-open");
	const refresh = find("hub-refresh");
	const models = find("hub-models");
	let generation = 0,
		loading = false;
	openLink.setAttribute("target", "_blank");
	openLink.setAttribute("rel", "noopener noreferrer");
	openLink.textContent = "OpenCodex 열기";
	const render = (status: HubStatus | null, loadError = "") => {
		const view = status
			? hubPresentation(status)
			: {
					live: false,
					summary: loadError,
					error: loadError,
					guiUrl: null,
				};
		statusNode.textContent = view.live ? "OpenCodex" : "OpenCodex 상태";
		summary.textContent = view.summary;
		errorNode.textContent = status ? view.error : loadError;
		if (view.guiUrl) {
			openLink.hidden = false;
			openLink.setAttribute("href", view.guiUrl);
		} else {
			openLink.hidden = true;
			openLink.setAttribute("href", "");
		}
		refresh.disabled = loading;
		models.hidden = !view.live;
		models.disabled = !view.live;
	};
	const load = async (refreshing: boolean) => {
		const mine = ++generation;
		loading = true;
		refresh.disabled = true;
		statusNode.textContent = refreshing
			? "모델 목록을 새로 고치는 중…"
			: "불러오는 중…";
		try {
			const value = await request(
				refreshing ? "/api/hub/refresh" : "/api/hub/status",
				refreshing ? "POST" : "GET",
				refreshing ? {} : undefined,
			);
			if (mine !== generation || !dialog.open) return;
			render(parseHubStatus(value));
			if (refreshing) options.onChanged();
		} catch (error) {
			if (mine !== generation || !dialog.open) return;
			render(
				null,
				error instanceof Error
					? error.message
					: "연결 상태를 확인하지 못했습니다.",
			);
		} finally {
			if (mine === generation) {
				loading = false;
				refresh.disabled = false;
			}
		}
	};
	refresh.addEventListener("click", () => {
		if (!loading) void load(true);
	});
	models.addEventListener("click", () => options.onModels());
	return {
		open() {
			return load(false);
		},
		close() {
			generation++;
			loading = false;
		},
	};
}
