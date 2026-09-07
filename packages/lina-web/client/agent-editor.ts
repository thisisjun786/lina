import type {
	AgentChange,
	AgentInput,
	AgentProfile,
	Dynamics,
} from "../../lina-core/src/agents/types.ts";

/**
 * Agent settings dialog and creation picker.
 *
 * The module is written against a minimal structural element contract so the
 * race-handling logic can be regression-tested without a browser (see
 * test/agent-editor.test.ts). At runtime the real DOM satisfies the contract.
 */

const REQUEST_TIMEOUT_MS = 15000;
const AVATAR_MAX_BYTES = 2097152;

export type RequestFn = (
	path: string,
	method?: string,
	body?: unknown,
	signal?: AbortSignal,
) => Promise<unknown>;

export interface Focusable {
	focus(): void;
	isConnected: boolean;
}

export interface EditorEvent {
	preventDefault(): void;
	currentTarget?: unknown;
}

export interface EditorNode {
	textContent: string | null;
	hidden: boolean;
	disabled: boolean;
	value: string;
	src: string;
	open: boolean;
	isConnected: boolean;
	type: string;
	id: string;
	className: string;
	files?: ArrayLike<{ name: string; size: number }> | null;
	elements?: { namedItem(name: string): unknown };
	focus(): void;
	click(): void;
	showModal(): void;
	close(): void;
	append(...nodes: EditorNode[]): void;
	after(...nodes: EditorNode[]): void;
	replaceChildren(...nodes: EditorNode[]): void;
	setAttribute(name: string, value: string): void;
	querySelectorAll(selector: string): Iterable<EditorNode>;
	addEventListener(type: string, listener: (event: EditorEvent) => void): void;
}

export interface EditorDocument {
	createElement(tag: string): EditorNode;
	getElementById(id: string): EditorNode | null;
}

/** Injectable seams so the editor can be exercised without a browser. */
export interface EditorDependencies {
	request: RequestFn;
	fetch: (input: string, init: RequestInit) => Promise<Response>;
	find: (id: string) => EditorNode;
	document: EditorDocument;
}

function setText(node: { textContent: string | null }, text: string): void {
	if (node.textContent !== text) node.textContent = text;
}

function withTimeout(signal?: AbortSignal): AbortSignal {
	const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
	return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

export async function agentRequest(
	path: string,
	method = "GET",
	body?: unknown,
	signal?: AbortSignal,
): Promise<unknown> {
	const response = await fetch(path, {
		method,
		headers: body ? { "Content-Type": "application/json" } : {},
		...(body ? { body: JSON.stringify(body) } : {}),
		signal: withTimeout(signal),
		redirect: "error",
	});
	const value: unknown = await response.json();
	if (!response.ok)
		throw Error(
			value && typeof value === "object" && "error" in value
				? String(value.error)
				: "연결을 확인해주세요.",
		);
	return value;
}

type Detail = {
	profile: AgentProfile;
	dynamics: Dynamics;
	changes: AgentChange[];
};
const FIELDS = [
	"name",
	"role",
	"personality",
	"voice",
	"profile",
	"appearance",
	"interests",
] as const;

function isAbort(error: unknown): boolean {
	return (
		error instanceof Error &&
		(error.name === "AbortError" || error.message.startsWith("aborted"))
	);
}

function message(error: unknown, fallback: string): string {
	if (error instanceof Error && error.name === "TimeoutError")
		return "응답이 없어 요청을 멈췄습니다. 잠시 후 다시 시도해주세요.";
	return error instanceof Error && error.message ? error.message : fallback;
}

function isFocusable(value: unknown): value is Focusable {
	return (
		typeof value === "object" &&
		value !== null &&
		typeof (value as Focusable).focus === "function"
	);
}

/** Focus the dialog opener, or the sidebar toggle when the opener is gone (mobile re-render). */
function returnFocus(doc: EditorDocument, opener: Focusable | undefined): void {
	if (opener?.isConnected) {
		opener.focus();
		return;
	}
	doc.getElementById("open-sidebar")?.focus();
}

function defaults(): EditorDependencies {
	const doc = (globalThis as { document?: EditorDocument }).document;
	if (!doc) throw new Error("Agent editor requires a document");
	return {
		request: agentRequest,
		fetch: (input, init) => fetch(input, init),
		find: (id) => {
			const found = doc.getElementById(id);
			if (!found) throw new Error(`Missing interface element: ${id}`);
			return found;
		},
		document: doc,
	};
}

export function createAgentEditor(
	changed: () => void,
	dependencies: Partial<EditorDependencies> = {},
	openConversation?: (id: string, from: Focusable) => void,
	openModels?: (id: string, from: Focusable) => void,
) {
	const {
		request,
		fetch: doFetch,
		find,
		document: doc,
	} = { ...defaults(), ...dependencies };
	const dialog = find("agent-dialog"),
		form = find("agent-form"),
		status = find("agent-edit-status"),
		save = find("save-agent"),
		image = find("agent-profile-image"),
		upload = find("agent-avatar-file"),
		avatarButton = find("change-agent-avatar"),
		growth = find("agent-growth"),
		heading = find("agent-heading"),
		evolution = find("agent-evolution");
	const retry = doc.createElement("button");
	retry.type = "button";
	retry.id = "agent-retry";
	retry.className = "secondary-button";
	retry.textContent = "다시 불러오기";
	retry.hidden = true;
	status.after(retry);

	// One generation per open(); every async completion checks it before touching the DOM.
	let generation = 0,
		detail: Detail | undefined,
		agentId: string | undefined,
		opener: Focusable | undefined,
		controller: AbortController | undefined,
		busy = 0;

	const field = (key: (typeof FIELDS)[number]): EditorNode | undefined => {
		const input = form.elements?.namedItem(key);
		return typeof input === "object" && input !== null && "value" in input
			? (input as EditorNode)
			: undefined;
	};
	const setActions = () => {
		const locked = busy > 0 || !detail;
		save.disabled = locked;
		avatarButton.disabled = locked;
		for (const button of growth.querySelectorAll("button"))
			button.disabled = locked;
		form.setAttribute("aria-busy", String(busy > 0));
	};
	const clear = () => {
		detail = undefined;
		setText(heading, "에이전트 설정");
		for (const key of FIELDS) {
			const input = field(key);
			if (input) input.value = "";
		}
		evolution.value = "adaptive";
		image.hidden = true;
		image.src = "";
		growth.replaceChildren();
		retry.hidden = true;
	};
	/** Abort in-flight work; the next open() or close starts a fresh generation. */
	const reset = () => {
		generation++;
		controller?.abort(new Error("aborted:generation"));
		controller = new AbortController();
		busy = 0;
		return { generation, signal: controller.signal };
	};

	const render = (id: string, value: Detail) => {
		detail = value;
		const { profile, dynamics, changes } = value;
		setText(heading, `${profile.name} 설정`);
		for (const key of FIELDS) {
			const input = field(key);
			if (input)
				input.value =
					key === "interests" ? profile.interests.join("\n") : profile[key];
		}
		evolution.value = profile.evolution;
		image.hidden = !profile.avatarId;
		image.src = profile.avatarId ? `/api/avatars/${profile.avatarId}` : "";
		growth.replaceChildren();
		const mood = doc.createElement("p");
		mood.textContent = dynamics.mood
			? `${dynamics.mood.label} · ${dynamics.mood.reason}`
			: "차분한 상태";
		growth.append(mood);
		for (const [label, values] of [
			["새로 생긴 관심", dynamics.interests],
			["취향", dynamics.preferences],
			["함께 쌓은 관계", dynamics.relationship],
		] as const) {
			if (!values.length) continue;
			const title = doc.createElement("h4");
			title.textContent = label;
			const list = doc.createElement("ul");
			for (const entry of values) {
				const item = doc.createElement("li");
				item.textContent = entry;
				list.append(item);
			}
			growth.append(title, list);
		}
		for (const item of changes.slice(0, 6)) {
			const row = doc.createElement("div");
			row.className = "agent-change";
			const text = doc.createElement("span");
			text.textContent = item.summary;
			row.append(text);
			if (item.kind === "reflection") {
				const undo = doc.createElement("button");
				undo.type = "button";
				undo.className = "text-button";
				undo.textContent = "되돌리기";
				undo.addEventListener("click", () => {
					if (!detail || busy || detail.profile.id !== id) return;
					void run(id, (signal) =>
						request(
							`/api/agents/${id}/revert`,
							"POST",
							{ revision: detail?.dynamics.revision, changeId: item.id },
							signal,
						).then(() => load(id, signal)),
					).then((ok) => ok && changed());
				});
				row.append(undo);
			}
			growth.append(row);
		}
	};

	const load = async (id: string, signal: AbortSignal): Promise<void> => {
		const value = (await request(
			`/api/agents/${id}`,
			"GET",
			undefined,
			signal,
		)) as Detail;
		if (signal.aborted) return;
		render(id, value);
	};

	/**
	 * Run one bounded action for the current generation. Resolves true only if the
	 * action finished while this generation was still active; stale completions
	 * are dropped without touching the DOM.
	 */
	const run = async (
		id: string,
		action: (signal: AbortSignal) => Promise<void>,
	): Promise<boolean> => {
		const mine = generation;
		const signal = controller?.signal ?? AbortSignal.abort();
		if (agentId !== id || signal.aborted) return false;
		busy++;
		setActions();
		setText(status, "");
		try {
			await action(signal);
			return mine === generation && !signal.aborted;
		} catch (error) {
			if (mine === generation && !isAbort(error))
				setText(status, message(error, "저장하지 못했습니다."));
			return false;
		} finally {
			if (mine === generation) {
				busy--;
				setActions();
			}
		}
	};

	form.addEventListener("submit", (event) => {
		event.preventDefault();
		if (!detail || busy) return;
		const id = detail.profile.id;
		const revision = detail.profile.revision;
		const patch: Record<string, unknown> = {};
		for (const key of FIELDS) {
			const input = field(key);
			if (!input) continue;
			patch[key] =
				key === "interests"
					? input.value
							.split("\n")
							.map((x) => x.trim())
							.filter(Boolean)
					: input.value;
		}
		patch["evolution"] = evolution.value;
		void run(id, (signal) =>
			request(`/api/agents/${id}`, "PATCH", { revision, patch }, signal).then(
				() => undefined,
			),
		).then((ok) => {
			if (!ok) return;
			changed();
			dialog.close();
		});
	});

	avatarButton.addEventListener("click", () => {
		if (!detail || busy) return;
		upload.click();
	});
	upload.addEventListener("change", () => {
		const file = upload.files?.[0];
		upload.value = "";
		if (!file || !detail || busy) return;
		const snapshot = detail;
		const id = snapshot.profile.id;
		if (file.size > AVATAR_MAX_BYTES) {
			setText(status, "이미지는 2MB까지 선택할 수 있습니다.");
			return;
		}
		void run(id, async (signal) => {
			const response = await doFetch(`/api/agents/${id}/avatar`, {
				method: "POST",
				headers: {
					"Content-Type": "application/octet-stream",
					"X-Lina-Filename": encodeURIComponent(file.name),
					"X-Lina-Revision": String(snapshot.profile.revision),
				},
				body: file as unknown as Blob,
				signal: withTimeout(signal),
			});
			if (signal.aborted) return;
			if (!response.ok)
				throw Error(
					"사진을 저장하지 못했습니다. PNG·JPEG 형식과 연결을 확인해주세요.",
				);
			const profile = (await response.json()) as AgentProfile;
			if (signal.aborted || detail?.profile.id !== id) return;
			detail = { ...detail, profile };
			image.src = `/api/avatars/${profile.avatarId}`;
			image.hidden = !profile.avatarId;
		}).then((ok) => ok && changed());
	});

	const conversationButton = doc.getElementById("open-conversation-settings");
	const modelButton = doc.createElement("button");
	modelButton.type = "button";
	modelButton.className = "text-button";
	modelButton.textContent = "이 에이전트의 모델 역할";
	modelButton.addEventListener("click", () => {
		if (!detail || busy || !openModels) return;
		openModels(detail.profile.id, modelButton);
	});
	conversationButton?.after(modelButton);
	conversationButton?.addEventListener("click", () => {
		if (!detail || busy || !openConversation) return;
		openConversation(detail.profile.id, conversationButton);
	});
	retry.addEventListener("click", () => {
		if (agentId) void open(agentId, opener);
	});
	for (const button of dialog.querySelectorAll("[data-close]"))
		button.addEventListener("click", () => dialog.close());
	dialog.addEventListener("close", () => {
		reset();
		clear();
		setActions();
		returnFocus(doc, opener);
	});

	async function open(id: string, from: Focusable | undefined): Promise<void> {
		const { generation: mine, signal } = reset();
		opener = from;
		agentId = id;
		clear();
		setText(status, "");
		busy = 1;
		setActions();
		if (!dialog.open) dialog.showModal();
		try {
			await load(id, signal);
		} catch (error) {
			if (mine !== generation) return;
			if (!isAbort(error)) {
				setText(status, message(error, "설정을 열지 못했습니다."));
				retry.hidden = false;
			}
		} finally {
			if (mine === generation) {
				busy = 0;
				setActions();
			}
		}
	}
	return { open };
}

export function createAgentPicker(
	presets: () => AgentInput[],
	navigate: (id: string) => void,
	dependencies: Partial<
		Pick<EditorDependencies, "request" | "find" | "document">
	> = {},
) {
	const { request, find, document: doc } = { ...defaults(), ...dependencies };
	const dialog = find("agent-create-dialog"),
		select = find("agent-preset"),
		name = find("new-agent-name"),
		error = find("agent-create-error"),
		button = find("create-agent"),
		form = find("agent-create-form");
	let opener: Focusable | undefined, controller: AbortController | undefined;
	select.addEventListener("change", () => {
		name.value = presets().find((p) => p.id === select.value)?.name ?? "";
	});
	form.addEventListener("submit", (event) => {
		event.preventDefault();
		if (button.disabled) return;
		button.disabled = true;
		controller = new AbortController();
		const signal = controller.signal;
		void request(
			"/api/agents",
			"POST",
			{ preset: select.value, name: name.value },
			signal,
		)
			.then((value) => {
				if (signal.aborted) return;
				dialog.close();
				navigate((value as AgentProfile).id);
			})
			.catch((e) => {
				if (!signal.aborted) setText(error, message(e, "추가하지 못했습니다."));
			})
			.finally(() => {
				if (!signal.aborted) button.disabled = false;
			});
	});
	for (const close of dialog.querySelectorAll("[data-close]"))
		close.addEventListener("click", () => dialog.close());
	dialog.addEventListener("close", () => {
		controller?.abort(new Error("aborted:closed"));
		button.disabled = false;
		returnFocus(doc, opener);
	});
	return (event?: EditorEvent) => {
		opener = isFocusable(event?.currentTarget)
			? event.currentTarget
			: undefined;
		select.replaceChildren(
			...[{ id: "custom", name: "직접 만들기" }, ...presets()].map((p) => {
				const option = doc.createElement("option");
				option.value = p.id;
				option.textContent = p.name;
				return option;
			}),
		);
		name.value = "";
		setText(error, "");
		button.disabled = false;
		if (!dialog.open) dialog.showModal();
	};
}
