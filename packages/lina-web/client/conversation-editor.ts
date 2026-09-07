import {
	buildConversationPatch,
	type ConversationExample,
	type ConversationProfile,
	conversationEndpoint,
	conversationPreferenceLabel,
	conversationPreferenceValue,
	validateConversationExamples,
} from "./conversation-draft.ts";

type LearnedPreference = {
	dimension: string;
	value: string;
	quote: string;
	sourceEntryId: string;
};
type ConversationResponse = {
	profile: ConversationProfile;
	preferences: { revision: number; items: LearnedPreference[] };
};

const REQUEST_TIMEOUT_MS = 15_000;
const MAX_EXAMPLES = 6;

function node<K extends keyof HTMLElementTagNameMap>(
	tag: K,
	className?: string,
): HTMLElementTagNameMap[K] {
	const element = document.createElement(tag);
	if (className) element.className = className;
	return element;
}

function text(
	tag: keyof HTMLElementTagNameMap,
	value: string,
	className?: string,
): HTMLElement {
	const element = node(tag as "p", className);
	element.textContent = value;
	return element;
}

function request(
	path: string,
	init: RequestInit = {},
	signal?: AbortSignal,
): Promise<unknown> {
	const deadline = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
	const requestSignal = signal ? AbortSignal.any([signal, deadline]) : deadline;
	return fetch(path, {
		...init,
		credentials: "same-origin",
		redirect: "error",
		signal: requestSignal,
		headers: {
			Accept: "application/json",
			...(init.body ? { "Content-Type": "application/json" } : {}),
			...init.headers,
		},
	}).then(async (response) => {
		const body = (await response.json().catch(() => undefined)) as
			| { error?: unknown }
			| undefined;
		if (!response.ok)
			throw new Error(
				typeof body?.error === "string" ? body.error : "저장하지 못했습니다.",
			);
		return body;
	});
}

function exampleRow(
	example: ConversationExample,
	remove: () => void,
): HTMLElement {
	const row = node("fieldset", "conversation-example");
	const legend = node("legend");
	legend.textContent = "대화 예시";
	const situation = node("textarea");
	situation.value = example.situation;
	situation.maxLength = 240;
	situation.rows = 2;
	situation.placeholder = "상황을 적어주세요";
	situation.setAttribute("aria-label", "상황");
	const response = node("textarea");
	response.value = example.response;
	response.maxLength = 400;
	response.rows = 3;
	response.placeholder = "이렇게 답해요";
	response.setAttribute("aria-label", "응답");
	const removeButton = node("button", "text-button");
	removeButton.type = "button";
	removeButton.textContent = "예시 빼기";
	removeButton.addEventListener("click", remove);
	row.append(
		legend,
		text("label", "상황"),
		situation,
		text("label", "응답"),
		response,
		removeButton,
	);
	return row;
}

export function createConversationEditor() {
	const dialog = document.getElementById("conversation-dialog");
	if (!(dialog instanceof HTMLDialogElement))
		throw new Error("대화 방식 창을 찾을 수 없습니다.");
	const form = dialog.querySelector<HTMLFormElement>("#conversation-form");
	const style = dialog.querySelector<HTMLTextAreaElement>(
		"#conversation-style",
	);
	const examples = dialog.querySelector<HTMLElement>("#conversation-examples");
	const preferences = dialog.querySelector<HTMLElement>(
		"#conversation-preferences",
	);
	const status = dialog.querySelector<HTMLElement>("#conversation-status");
	const save = dialog.querySelector<HTMLButtonElement>("#save-conversation");
	const add = dialog.querySelector<HTMLButtonElement>(
		"#add-conversation-example",
	);
	const reset = dialog.querySelector<HTMLButtonElement>(
		"#reset-conversation-preferences",
	);
	const retry = dialog.querySelector<HTMLButtonElement>("#conversation-retry");
	if (
		!form ||
		!style ||
		!examples ||
		!preferences ||
		!status ||
		!save ||
		!add ||
		!reset ||
		!retry
	)
		throw new Error("대화 방식 창 요소가 부족합니다.");
	for (const closeButton of dialog.querySelectorAll<HTMLButtonElement>(
		"[data-close]",
	)) {
		closeButton.addEventListener("click", () => dialog.close());
	}

	let current: ConversationResponse | undefined;
	let agentId = "";
	let generation = 0;
	let controller: AbortController | undefined;
	let opener: HTMLElement | undefined;
	let failed = false;
	let busy = false;

	const setStatus = (value: string, error = false) => {
		status.textContent = value;
		status.setAttribute("data-state", error ? "error" : "");
	};
	const setBusy = (pending: boolean) => {
		busy = pending;
		save.disabled = busy || failed;
		add.disabled = busy || failed;
		reset.disabled = busy || failed;
		form.setAttribute("aria-busy", String(busy));
	};
	const readExamples = (): ConversationExample[] =>
		Array.from(
			examples.querySelectorAll(
				".conversation-example",
			) as NodeListOf<HTMLFieldSetElement>,
		).map((row) => ({
			situation:
				(
					row.querySelector(
						'textarea[aria-label="상황"]',
					) as HTMLTextAreaElement | null
				)?.value ?? "",
			response:
				(
					row.querySelector(
						'textarea[aria-label="응답"]',
					) as HTMLTextAreaElement | null
				)?.value ?? "",
		}));
	const renderExamples = (items: ConversationExample[]) => {
		examples.replaceChildren(
			...items.map((item, index) =>
				exampleRow(item, () => {
					if (failed || busy) return;
					const next = readExamples();
					next.splice(index, 1);
					renderExamples(next);
				}),
			),
		);
		add.hidden = items.length >= MAX_EXAMPLES;
	};
	const renderPreferences = (items: LearnedPreference[]) => {
		preferences.replaceChildren();
		if (!items.length) {
			preferences.append(
				text("p", "아직 배운 대화 선호가 없습니다.", "conversation-empty"),
			);
			return;
		}
		for (const item of items) {
			const section = node("details", "conversation-preference");
			const summary = node("summary");
			summary.textContent = `${conversationPreferenceLabel(item.dimension)} · ${conversationPreferenceValue(item.value)}`;
			section.append(
				summary,
				text("p", item.quote || "인용할 내용이 없습니다."),
			);
			preferences.append(section);
		}
	};
	const load = async (id: string, run: number, signal: AbortSignal) => {
		const value = (await request(
			conversationEndpoint(id),
			{},
			signal,
		)) as ConversationResponse;
		if (run !== generation) return;
		current = value;
		failed = false;
		style.value = value.profile.style;
		renderExamples(value.profile.examples);
		renderPreferences(value.preferences.items);
		setStatus("");
		setBusy(false);
		retry.hidden = true;
	};
	const run = async (action: (signal: AbortSignal) => Promise<void>) => {
		const runId = generation;
		const signal = controller?.signal;
		if (!signal || busy) return;
		setBusy(true);
		try {
			await action(signal);
			if (runId === generation && !failed) setBusy(false);
		} catch (error) {
			if (runId !== generation || signal.aborted) return;
			failed = true;
			retry.hidden = false;
			setStatus(
				error instanceof Error ? error.message : "요청하지 못했습니다.",
				true,
			);
			setBusy(false);
		}
	};
	retry.addEventListener("click", () => {
		if (!agentId || !controller || !failed) return;
		generation++;
		const currentGeneration = generation;
		controller.abort();
		controller = new AbortController();
		failed = false;
		retry.hidden = true;
		setStatus("불러오는 중…");
		setBusy(true);
		const activeSignal = controller.signal;
		void load(agentId, generation, activeSignal).catch((error) => {
			if (generation !== currentGeneration || activeSignal.aborted) return;
			failed = true;
			retry.hidden = false;
			setStatus(
				error instanceof Error ? error.message : "불러오지 못했습니다.",
				true,
			);
			setBusy(false);
		});
	});
	add.addEventListener("click", () => {
		if (busy || failed) return;
		const items = readExamples();
		if (items.length < MAX_EXAMPLES)
			renderExamples([...items, { situation: "", response: "" }]);
	});
	reset.addEventListener("click", () => {
		if (!current || failed || busy) return;
		const actionGeneration = generation;
		void run(async (signal) => {
			const value = (await request(
				`${conversationEndpoint(agentId)}/preferences/reset`,
				{
					method: "POST",
					body: JSON.stringify({ revision: current?.preferences.revision }),
				},
				signal,
			)) as ConversationResponse["preferences"];
			if (generation !== actionGeneration) return;
			if (!current) return;
			current = { ...current, preferences: value };
			renderPreferences(value.items);
			setStatus("대화 선호를 초기화했습니다.");
		});
	});

	form.addEventListener("submit", (event) => {
		event.preventDefault();
		if (!current || failed || busy) return;
		const actionGeneration = generation;
		const profileRevision = current.profile.revision;
		const nextExamples = readExamples();
		const error = validateConversationExamples(nextExamples);
		if (error) return setStatus(error, true);
		void run(async (signal) => {
			const value = (await request(
				conversationEndpoint(agentId),
				{
					method: "PATCH",
					body: JSON.stringify(
						buildConversationPatch(profileRevision, {
							style: style.value,
							examples: nextExamples,
						}),
					),
				},
				signal,
			)) as ConversationProfile;
			if (generation !== actionGeneration) return;
			if (!current) return;
			current = { ...current, profile: value };
			dialog.close();
		});
	});
	dialog.addEventListener("close", () => {
		generation++;
		controller?.abort();
		current = undefined;
		failed = false;
		retry.hidden = true;
		const previousOpener = opener;
		opener = undefined;
		setBusy(false);
		previousOpener?.focus();
	});
	return {
		open(id: string, from: HTMLElement) {
			generation++;
			const currentGeneration = generation;
			controller?.abort();
			controller = new AbortController();
			agentId = id;
			opener = from;
			failed = false;
			current = undefined;
			style.value = "";
			examples.replaceChildren();
			preferences.replaceChildren();
			retry.hidden = true;
			setStatus("불러오는 중…");
			setBusy(true);
			dialog.setAttribute("data-return-focus-id", from.id);
			if (!dialog.open) dialog.showModal();
			const activeSignal = controller.signal;
			void load(id, generation, activeSignal).catch((error) => {
				if (generation !== currentGeneration || activeSignal.aborted) return;
				failed = true;
				retry.hidden = false;
				setStatus(
					error instanceof Error ? error.message : "불러오지 못했습니다.",
					true,
				);
				setBusy(false);
			});
		},
	};
}
