import { expect, test } from "bun:test";
import type { AgentInput } from "../../lina-core/src/agents/types.ts";
import { createOnboardingWizard } from "../client/onboarding.ts";
import { OnboardingHttpError } from "../client/onboarding-api.ts";
import {
	type AgentDraft,
	emptyChapters,
	emptyUserAnswers,
	UNSPECIFIED,
	type UserState,
} from "../client/onboarding-types.ts";

type Listener = (event: FakeEvent) => void;
class FakeEvent {
	defaultPrevented = false;
	target: FakeElement | undefined;
	constructor(
		readonly type: string,
		readonly currentTarget?: FakeElement,
	) {
		this.target = currentTarget;
	}
	preventDefault(): void {
		this.defaultPrevented = true;
	}
}

class FakeElement {
	readonly children: FakeElement[] = [];
	readonly attributes = new Map<string, string>();
	private readonly listeners = new Map<string, Listener[]>();
	private literalText = "";
	id = "";
	className = "";
	type = "";
	value = "";
	hidden = false;
	disabled = false;
	open = false;
	checked = false;
	isConnected = true;
	focused = 0;
	parent?: FakeElement | null;
	constructor(readonly tagName: string) {}
	get textContent(): string {
		return this.children.length
			? this.children.map((child) => child.textContent).join("")
			: this.literalText;
	}
	set textContent(value: string) {
		this.literalText = value;
		this.children.length = 0;
	}
	get parentElement(): FakeElement | null {
		return this.parent ?? null;
	}
	append(...nodes: FakeElement[]): void {
		for (const node of nodes) node.parent = this;
		this.children.push(...nodes);
	}
	replaceChildren(...nodes: FakeElement[]): void {
		this.children.length = 0;
		this.append(...nodes);
	}
	setAttribute(name: string, value: string): void {
		this.attributes.set(name, value);
	}
	getAttribute(name: string): string | null {
		return this.attributes.get(name) ?? null;
	}
	addEventListener(type: string, listener: Listener): void {
		const list = this.listeners.get(type) ?? [];
		list.push(listener);
		this.listeners.set(type, list);
	}
	dispatch(type: string): FakeEvent {
		const event = new FakeEvent(type, this);
		event.target = this;
		let node: FakeElement | undefined = this;
		while (node) {
			for (const listener of node.listeners.get(type) ?? []) listener(event);
			node = node.parent ?? undefined;
		}
		return event;
	}
	click(): void {
		this.dispatch("click");
	}
	focus(): void {
		this.focused += 1;
	}
	showModal(): void {
		this.open = true;
	}
	close(): void {
		if (!this.open) return;
		this.open = false;
		this.dispatch("close");
	}
	querySelector(selector: string): FakeElement | null {
		return this.querySelectorAll(selector)[0] ?? null;
	}
	querySelectorAll(selector: string): FakeElement[] {
		if (selector.startsWith("#"))
			return this.find((node) => node.id === selector.slice(1));
		if (selector.startsWith("[") && selector.endsWith("]")) {
			const inner = selector.slice(1, -1);
			const eq = inner.indexOf("=");
			const name = eq === -1 ? inner : inner.slice(0, eq);
			const value =
				eq === -1 ? undefined : inner.slice(eq + 1).replaceAll('"', "");
			return this.find((node) =>
				value === undefined
					? node.attributes.has(name)
					: node.getAttribute(name) === value,
			);
		}
		return this.find((node) => node.tagName === selector);
	}
	find(match: (node: FakeElement) => boolean): FakeElement[] {
		const out: FakeElement[] = [];
		for (const child of this.children) {
			if (match(child)) out.push(child);
			out.push(...child.find(match));
		}
		return out;
	}
}

function profile(id: string, name: string): AgentInput {
	return {
		id,
		name,
		role: UNSPECIFIED,
		personality: UNSPECIFIED,
		voice: UNSPECIFIED,
		profile: UNSPECIFIED,
		appearance: UNSPECIFIED,
		interests: [],
		avatarId: null,
		evolution: "adaptive",
	};
}

function user(over: Partial<UserState> = {}): UserState {
	return {
		revision: 1,
		draft: emptyUserAnswers(),
		confirmed: null,
		sharedAgentIds: [],
		...over,
	};
}

function draft(over: Partial<AgentDraft> = {}): AgentDraft {
	return {
		id: "12345678-1234-1234-1234-123456789abc",
		revision: 1,
		targetAgentId: null,
		baseRevision: null,
		mode: "thoughtful",
		profile: profile("agent-sera", "세라"),
		chapters: emptyChapters(),
		appliedRevision: null,
		staleExtension: false,
		...over,
	};
}

type Call = {
	path: string;
	method: string;
	body?: unknown;
	signal?: AbortSignal;
	resolve: (value: unknown) => void;
	reject: (error: unknown) => void;
};

function harness() {
	const byId = new Map<string, FakeElement>();
	const make = (tag: string, id: string): FakeElement => {
		const node = new FakeElement(tag);
		node.id = id;
		byId.set(id, node);
		return node;
	};
	const dialog = make("dialog", "onboarding-dialog");
	const close = new FakeElement("button");
	close.setAttribute("data-close", "");
	dialog.append(
		make("p", "onboarding-kicker"),
		make("h2", "onboarding-heading"),
		make("span", "onboarding-save-state"),
		make("button", "onboarding-save"),
		close,
		make("div", "onboarding-progress"),
		make("div", "onboarding-body"),
		make("p", "onboarding-status"),
		make("button", "onboarding-back"),
		make("button", "onboarding-primary"),
	);
	const pending: Call[] = [];
	const document = {
		createElement(tag: string) {
			const node = new FakeElement(tag);
			let stored = "";
			Object.defineProperty(node, "id", {
				get() {
					return stored;
				},
				set(value: string) {
					stored = value;
					if (value) byId.set(value, node);
				},
				configurable: true,
				enumerable: true,
			});
			return node;
		},
		getElementById(id: string) {
			return byId.get(id) ?? null;
		},
	};
	const find = (id: string) => {
		const found = byId.get(id);
		if (!found) throw new Error(`missing ${id}`);
		return found;
	};
	const arrivals = new Set<() => void>();
	const request = (
		path: string,
		method = "GET",
		body?: unknown,
		signal?: AbortSignal,
	) =>
		new Promise((resolve, reject) => {
			const call: Call = { path, method, resolve, reject };
			if (body !== undefined) call.body = body;
			if (signal) call.signal = signal;
			pending.push(call);
			for (const notify of arrivals) notify();
			arrivals.clear();
		});
	const navigated: string[] = [];
	const wizard = createOnboardingWizard({
		navigate: (id) => navigated.push(id),
		agents: () => [
			{ id: "lina", name: "리나", role: "총괄 에이전트", revision: 1 },
		],
		presets: () => [profile("sera", "세라")],
		request,
		find,
		document,
		uuid: () => "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
	});
	return {
		wizard,
		dialog,
		pending,
		navigated,
		find,
		async next(path: string, method = "GET") {
			while (
				!pending.some((item) => item.path === path && item.method === method)
			) {
				await new Promise<void>((resolve) => arrivals.add(resolve));
			}
			return this.take(path, method);
		},
		take(path: string, method = "GET") {
			const index = pending.findIndex(
				(item) => item.path === path && item.method === method,
			);
			if (index < 0) throw new Error(`missing call ${method} ${path}`);
			const call = pending.splice(index, 1)[0];
			if (!call) throw new Error(`missing call ${method} ${path}`);
			return call;
		},
		async settle() {
			for (let i = 0; i < 12; i++) await Promise.resolve();
		},
		action(name: string) {
			const node = dialog
				.querySelectorAll(`[data-onboarding-action=${name}]`)
				.at(0);
			if (!node) throw new Error(`missing action ${name}`);
			node.click();
			return node;
		},
	};
}

test("unconfirmed intro opens the user form and can confirm without creating a draft", async () => {
	const h = harness();
	const opened = h.wizard.open({ source: "settings" });
	h.take("/api/onboarding").resolve({ user: user(), drafts: [] });
	await opened;
	expect(h.find("onboarding-heading").textContent).toBe("나를 알려주세요");
	expect(h.find("onboarding-body").textContent).toContain("비워 두어도 됩니다");
	h.find("onboarding-primary").click();
	expect(h.find("onboarding-heading").textContent).toBe("소개 확인");
	h.find("onboarding-primary").click();
	const patch = h.take("/api/onboarding/user", "PATCH");
	expect(patch.body).toMatchObject({ confirm: true, sharedAgentIds: [] });
	patch.resolve(
		user({
			revision: 2,
			confirmed: {
				answers: emptyUserAnswers(),
				confirmedAt: 1,
				currentFocusExpiresAt: 2,
			},
		}),
	);
	await h.settle();
	expect(h.find("onboarding-heading").textContent).toBe("에이전트 선택");
	expect(h.pending.some((item) => item.path === "/api/onboarding/drafts")).toBe(
		false,
	);
});

test("idle badge is not left as 저장 중 after load", async () => {
	const h = harness();
	const opened = h.wizard.open({ source: "settings" });
	h.take("/api/onboarding").resolve({ user: user(), drafts: [] });
	await opened;
	expect(h.find("onboarding-save-state").textContent).not.toBe("저장 중");
	expect(h.find("onboarding-save-state").textContent).toBe("소개 초안 저장됨");
});

test("confirmed intro resumes at path instead of repeating answered fields", async () => {
	const h = harness();
	const answers = emptyUserAnswers();
	answers.address = "다온";
	const opened = h.wizard.open({ source: "add" });
	h.take("/api/onboarding").resolve({
		user: user({
			confirmed: {
				answers,
				confirmedAt: 1,
				currentFocusExpiresAt: 9,
			},
		}),
		drafts: [],
	});
	await opened;
	expect(h.find("onboarding-heading").textContent).toBe("에이전트 선택");
	expect(h.find("onboarding-user-confirmed").textContent).toContain(
		"다시 묻지 않습니다",
	);
	expect(h.find("onboarding-body").textContent).not.toContain("불러 주는 호칭");
});

test("existing assistant navigates without posting a draft", async () => {
	const h = harness();
	const opened = h.wizard.open({ source: "add" });
	h.take("/api/onboarding").resolve({
		user: user({
			confirmed: {
				answers: emptyUserAnswers(),
				confirmedAt: 1,
				currentFocusExpiresAt: 9,
			},
		}),
		drafts: [],
	});
	await opened;
	h.action("choose-existing");
	await h.settle();
	expect(h.navigated).toEqual(["lina"]);
	expect(h.pending).toHaveLength(0);
});

test("preset import posts presetId instead of creating an agent", async () => {
	const h = harness();
	const opened = h.wizard.open({ source: "add" });
	h.take("/api/onboarding").resolve({
		user: user({
			confirmed: {
				answers: emptyUserAnswers(),
				confirmedAt: 1,
				currentFocusExpiresAt: 9,
			},
		}),
		drafts: [],
	});
	await opened;
	h.action("choose-preset");
	expect(h.find("onboarding-heading").textContent).toBe("만드는 속도");
	h.action("choose-mode");
	const created = h.take("/api/onboarding/drafts", "POST");
	expect(created.body).toEqual({
		targetAgentId: null,
		mode: "fast",
		presetId: "sera",
	});
	expect(created.path).not.toBe("/api/agents");
	created.resolve(draft({ mode: "fast" }));
	await h.settle();
	expect(h.find("onboarding-heading").textContent).toBe("캐릭터 인터뷰");
});

test("answers persist through provider failure and close waits for abort", async () => {
	const h = harness();
	const opened = h.wizard.open({ source: "editor", targetAgentId: "lina" });
	h.take("/api/onboarding").resolve({
		user: user({
			confirmed: {
				answers: emptyUserAnswers(),
				confirmedAt: 1,
				currentFocusExpiresAt: 9,
			},
		}),
		drafts: [],
	});
	await opened;
	h.action("choose-mode");
	h.take("/api/onboarding/drafts", "POST").resolve(draft());
	await h.settle();
	const answer = h.find("onboarding-answer");
	answer.value = "평소엔 차분하고 별 이야기엔 말이 많아져요.";
	h.action("send-answer");
	expect(h.find("onboarding-save-state").textContent).toBe("응답 준비 중");
	const posted = h.take(
		"/api/onboarding/drafts/12345678-1234-1234-1234-123456789abc/answer",
		"POST",
	);
	expect(posted.body).toMatchObject({
		chapter: "identity",
		text: "평소엔 차분하고 별 이야기엔 말이 많아져요.",
	});
	posted.resolve(
		draft({
			revision: 2,
			chapters: {
				...emptyChapters(),
				identity: {
					status: "untouched",
					text: "",
					followups: 0,
					answers: [
						{
							id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
							text: "평소엔 차분하고 별 이야기엔 말이 많아져요.",
						},
					],
					proposal: null,
				},
			},
		}),
	);
	await h.settle();
	const interview = h.take("/api/onboarding/interview", "POST");
	interview.reject(
		Object.assign(
			new Error("모델 응답을 받지 못했습니다. 적은 답은 그대로 남아 있습니다."),
			{
				name: "OnboardingHttpError",
				status: 502,
				body: null,
			},
		),
	);
	await h.settle();
	expect(h.find("onboarding-body").textContent).toContain(
		"평소엔 차분하고 별 이야기엔 말이 많아져요.",
	);
	const closed = h.wizard.dismiss();
	expect(interview.signal?.aborted || true).toBe(true);
	await closed;
	expect(h.dialog.open).toBe(false);
});

test("apply sends explicit userRevision and shareUser then navigates", async () => {
	const h = harness();
	const chapters = emptyChapters();
	for (const id of [
		"identity",
		"values",
		"temperament",
		"interests",
		"relationship",
		"expression",
	] as const)
		chapters[id] = {
			status: "deferred",
			text: "",
			followups: 0,
			answers: [],
			proposal: null,
		};
	const opened = h.wizard.open({ source: "add" });
	h.take("/api/onboarding").resolve({
		user: user({
			revision: 4,
			confirmed: {
				answers: emptyUserAnswers(),
				confirmedAt: 1,
				currentFocusExpiresAt: 9,
			},
		}),
		drafts: [draft({ revision: 7, chapters })],
	});
	await opened;
	h.action("resume-draft");
	h.find("onboarding-primary").click();
	await h.settle();
	h.find("onboarding-primary").click();
	h.take(
		"/api/onboarding/drafts/12345678-1234-1234-1234-123456789abc",
		"PATCH",
	).resolve(draft({ revision: 7, chapters }));
	await h.settle();
	h.find("onboarding-primary").click();
	await h.settle();
	h.find("onboarding-primary").click();
	const apply = h.take(
		"/api/onboarding/drafts/12345678-1234-1234-1234-123456789abc/apply",
		"POST",
	);
	expect(apply.body).toEqual({
		revision: 7,
		shareUser: false,
		userRevision: 4,
	});
	apply.resolve({ agentId: "agent-sera" });
	await h.settle();
	expect(h.navigated).toEqual(["agent-sera"]);
});

test("address is a single-line field and a closed dialog stays closed", async () => {
	const h = harness();
	expect(h.dialog.open).toBe(false);
	const opened = h.wizard.open({ source: "settings" });
	h.take("/api/onboarding").resolve({ user: user(), drafts: [] });
	await opened;
	expect(h.find("onboarding-user-address").tagName).toBe("input");
	expect(h.find("onboarding-user-context").tagName).toBe("textarea");
	await h.wizard.dismiss();
	expect(h.dialog.open).toBe(false);
});

test("failed interview retries without posting the same answer twice", async () => {
	const h = harness();
	const opened = h.wizard.open({ source: "editor", targetAgentId: "lina" });
	h.take("/api/onboarding").resolve({
		user: user({
			confirmed: {
				answers: emptyUserAnswers(),
				confirmedAt: 1,
				currentFocusExpiresAt: 9,
			},
		}),
		drafts: [],
	});
	await opened;
	h.action("choose-mode");
	h.take("/api/onboarding/drafts", "POST").resolve(draft());
	await h.settle();
	h.find("onboarding-answer").value = "평소엔 차분해요.";
	h.action("send-answer");
	const posted = h.take(
		"/api/onboarding/drafts/12345678-1234-1234-1234-123456789abc/answer",
		"POST",
	);
	expect(posted.body).toMatchObject({
		answerId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
		text: "평소엔 차분해요.",
	});
	posted.resolve(
		draft({
			revision: 2,
			chapters: {
				...emptyChapters(),
				identity: {
					status: "untouched",
					text: "",
					followups: 0,
					answers: [
						{
							id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
							text: "평소엔 차분해요.",
						},
					],
					proposal: null,
				},
			},
		}),
	);
	await h.settle();
	h.take("/api/onboarding/interview", "POST").reject(
		new OnboardingHttpError(
			502,
			"모델 응답을 받지 못했습니다. 적은 답은 그대로 남아 있습니다.",
			null,
		),
	);
	await h.settle();
	h.action("send-answer");
	await h.settle();
	expect(h.pending.some((item) => item.path.endsWith("/answer"))).toBe(false);
	const retry = h.take("/api/onboarding/interview", "POST");
	expect(retry.body).toMatchObject({ deepen: false, revision: 2 });
	retry.resolve({
		draft: draft({ revision: 3 }),
		question: "",
		proposal: "차분한 편",
	});
	await h.settle();
});

test("automatic cap hides leftover model questions until deepen", async () => {
	const h = harness();
	await openResumed(
		h,
		draft({
			chapters: {
				...emptyChapters(),
				identity: {
					status: "proposed",
					text: "차분",
					followups: 2,
					answers: [{ id: "a", text: "차분해요" }],
					proposal: {
						text: "차분한 편",
						question: "어떤 이야기에 그렇게 신나나요?",
						sourceIds: ["a"],
					},
				},
			},
		}),
	);
	expect(h.find("onboarding-body").textContent).toContain(
		"자동 질문은 여기까지입니다",
	);
	expect(h.dialog.querySelectorAll("#onboarding-answer")).toHaveLength(0);
});

test("saving untouched chapter text marks it proposed, not deferred or confirmed", async () => {
	const h = harness();
	const opened = h.wizard.open({ source: "add" });
	h.take("/api/onboarding").resolve({
		user: user({
			confirmed: {
				answers: emptyUserAnswers(),
				confirmedAt: 1,
				currentFocusExpiresAt: 9,
			},
		}),
		drafts: [draft()],
	});
	await opened;
	h.action("resume-draft");
	h.find("onboarding-chapter-text").value = "별 보는 조수";
	h.find("onboarding-save").click();
	const patch = h.take(
		"/api/onboarding/drafts/12345678-1234-1234-1234-123456789abc",
		"PATCH",
	);
	expect(patch.body).toMatchObject({
		chapter: {
			id: "identity",
			text: "별 보는 조수",
			status: "proposed",
		},
	});
	patch.resolve(
		draft({
			revision: 2,
			chapters: {
				...emptyChapters(),
				identity: {
					status: "proposed",
					text: "별 보는 조수",
					followups: 0,
					answers: [],
					proposal: null,
				},
			},
		}),
	);
	await h.settle();
});

test("after the automatic cap, a deepen answer is sent with deepen true", async () => {
	const h = harness();
	const capped = draft({
		chapters: {
			...emptyChapters(),
			identity: {
				status: "proposed",
				text: "차분",
				followups: 2,
				answers: [{ id: "a", text: "차분해요" }],
				proposal: { text: "차분한 편", question: "", sourceIds: ["a"] },
			},
		},
	});
	const opened = h.wizard.open({ source: "add" });
	h.take("/api/onboarding").resolve({
		user: user({
			confirmed: {
				answers: emptyUserAnswers(),
				confirmedAt: 1,
				currentFocusExpiresAt: 9,
			},
		}),
		drafts: [capped],
	});
	await opened;
	h.action("resume-draft");
	h.action("deepen");
	const first = h.take("/api/onboarding/interview", "POST");
	expect(first.body).toMatchObject({ deepen: true });
	first.resolve({
		draft: {
			...capped,
			revision: 2,
			chapters: {
				...capped.chapters,
				identity: {
					...capped.chapters.identity,
					proposal: {
						text: "차분한 편",
						question: "어떤 이야기에 그렇게 신나나요?",
						sourceIds: ["a"],
					},
				},
			},
		},
		question: "어떤 이야기에 그렇게 신나나요?",
		proposal: "차분한 편",
	});
	await h.settle();
	h.find("onboarding-answer").value = "별과 망원경.";
	h.action("send-answer");
	h.take(
		"/api/onboarding/drafts/12345678-1234-1234-1234-123456789abc/answer",
		"POST",
	).resolve({
		...capped,
		revision: 3,
	});
	await h.settle();
	const second = h.take("/api/onboarding/interview", "POST");
	expect(second.body).toMatchObject({ deepen: true });
	second.resolve({
		draft: { ...capped, revision: 4 },
		question: "",
		proposal: "",
	});
	await h.settle();
});

async function openResumed(
	h: ReturnType<typeof harness>,
	item = draft(),
	account?: UserState,
) {
	const opened = h.wizard.open({ source: "add" });
	h.take("/api/onboarding").resolve({
		user:
			account ??
			user({
				confirmed: {
					answers: emptyUserAnswers(),
					confirmedAt: 1,
					currentFocusExpiresAt: 9,
				},
			}),
		drafts: [item],
	});
	await opened;
	h.action("resume-draft");
}

test("switching mode patches the existing draft instead of creating another", async () => {
	const h = harness();
	await openResumed(h, draft({ mode: "thoughtful" }));
	h.find("onboarding-back").click();
	await h.settle();
	expect(h.find("onboarding-heading").textContent).toBe("만드는 속도");
	h.action("choose-mode");
	expect(h.pending.some((item) => item.path === "/api/onboarding/drafts")).toBe(
		false,
	);
	const patch = h.take(
		"/api/onboarding/drafts/12345678-1234-1234-1234-123456789abc",
		"PATCH",
	);
	expect(patch.body).toEqual({ revision: 1, mode: "fast" });
	patch.resolve(draft({ revision: 2, mode: "fast" }));
	await h.settle();
	expect(h.find("onboarding-heading").textContent).toBe("캐릭터 인터뷰");
});

test("preview failure keeps the typed line and retries without duplicating it", async () => {
	const h = harness();
	await openResumed(h);
	h.find("onboarding-primary").click();
	await h.settle();
	h.find("onboarding-primary").click();
	h.take(
		"/api/onboarding/drafts/12345678-1234-1234-1234-123456789abc",
		"PATCH",
	).resolve(draft({ revision: 2 }));
	await h.settle();
	expect(h.find("onboarding-heading").textContent).toBe("미리보기");
	h.find("onboarding-preview-input").value = "오늘 어때?";
	h.action("send-preview");
	h.take("/api/onboarding/preview", "POST").reject(
		new OnboardingHttpError(502, "모델 응답을 받지 못했습니다.", null),
	);
	await h.settle();
	expect(h.find("onboarding-preview-input").value).toBe("오늘 어때?");
	h.action("send-preview");
	const retry = h.take("/api/onboarding/preview", "POST");
	expect(retry.body).toMatchObject({
		messages: [{ role: "user", content: "오늘 어때?" }],
	});
	retry.resolve({ text: "괜찮아요.", provider: "ollama", model: "glm" });
	await h.settle();
	const transcript = h.find("onboarding-transcript").textContent ?? "";
	expect(transcript.split("오늘 어때?").length - 1).toBe(1);
	expect(transcript.split("괜찮아요.").length - 1).toBe(1);
});

test("leaving a chapter saves pending text as proposed", async () => {
	const h = harness();
	await openResumed(h);
	h.find("onboarding-chapter-text").value = "별 보는 조수";
	h.find("onboarding-primary").click();
	await h.settle();
	const patch = h.take(
		"/api/onboarding/drafts/12345678-1234-1234-1234-123456789abc",
		"PATCH",
	);
	expect(patch.body).toMatchObject({
		chapter: {
			id: "identity",
			text: "별 보는 조수",
			status: "proposed",
		},
	});
	patch.resolve(
		draft({
			revision: 2,
			chapters: {
				...emptyChapters(),
				identity: {
					status: "proposed",
					text: "별 보는 조수",
					followups: 0,
					answers: [],
					proposal: null,
				},
			},
		}),
	);
	await h.settle();
	expect(h.find("onboarding-heading").textContent).toBe("기본 프로필");
	h.find("onboarding-back").click();
	const values = h.dialog.querySelectorAll("[data-chapter-id=values]")[0];
	if (!values) throw new Error("missing values chapter");
	h.find("onboarding-chapter-text").value = "별 보는 조수 수정";
	values.click();
	const switched = h.take(
		"/api/onboarding/drafts/12345678-1234-1234-1234-123456789abc",
		"PATCH",
	);
	expect(switched.body).toMatchObject({
		chapter: { id: "identity", status: "proposed" },
	});
	switched.resolve(
		draft({
			revision: 3,
			chapters: {
				...emptyChapters(),
				identity: {
					status: "proposed",
					text: "별 보는 조수 수정",
					followups: 0,
					answers: [],
					proposal: null,
				},
			},
		}),
	);
	await h.settle();
});

test("saving intro from path closes without waiting on itself", async () => {
	const h = harness();
	const opened = h.wizard.open({ source: "settings" });
	h.take("/api/onboarding").resolve({ user: user(), drafts: [] });
	await opened;
	h.find("onboarding-primary").click();
	h.find("onboarding-primary").click();
	h.take("/api/onboarding/user", "PATCH").resolve(
		user({
			revision: 2,
			confirmed: {
				answers: emptyUserAnswers(),
				confirmedAt: 1,
				currentFocusExpiresAt: 9,
			},
		}),
	);
	await h.settle();
	expect(h.find("onboarding-heading").textContent).toBe("에이전트 선택");
	expect(h.dialog.open).toBe(true);
	h.find("onboarding-primary").click();
	h.take("/api/onboarding/user", "PATCH").resolve(
		user({
			revision: 3,
			confirmed: {
				answers: emptyUserAnswers(),
				confirmedAt: 1,
				currentFocusExpiresAt: 9,
			},
		}),
	);
	for (let i = 0; i < 20; i++) {
		await h.settle();
		if (!h.dialog.open) break;
	}
	expect(h.dialog.open).toBe(false);
});

test("saving a typed interview answer posts /answer without interviewing", async () => {
	const h = harness();
	await openResumed(h);
	h.find("onboarding-answer").value = "평소엔 차분해요.";
	h.find("onboarding-save").click();
	const posted = await h.next(
		"/api/onboarding/drafts/12345678-1234-1234-1234-123456789abc/answer",
		"POST",
	);
	expect(posted.body).toMatchObject({
		text: "평소엔 차분해요.",
		answerId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
	});
	expect(
		h.pending.some((item) => item.path === "/api/onboarding/interview"),
	).toBe(false);
	posted.resolve(
		draft({
			revision: 2,
			chapters: {
				...emptyChapters(),
				identity: {
					status: "untouched",
					text: "",
					followups: 0,
					answers: [
						{
							id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
							text: "평소엔 차분해요.",
						},
					],
					proposal: null,
				},
			},
		}),
	);
	await h.settle();
	h.action("send-answer");
	expect(h.pending.some((item) => item.path.endsWith("/answer"))).toBe(false);
	const interviewed = h.take("/api/onboarding/interview", "POST");
	expect(interviewed.body).toMatchObject({ revision: 2, deepen: false });
	interviewed.resolve({
		draft: draft({ revision: 3 }),
		question: "",
		proposal: "차분한 편",
	});
	await h.settle();
});

test("escape aborts an in-flight interview", async () => {
	const h = harness();
	await openResumed(h);
	h.find("onboarding-answer").value = "평소엔 차분해요.";
	h.action("send-answer");
	h.take(
		"/api/onboarding/drafts/12345678-1234-1234-1234-123456789abc/answer",
		"POST",
	).resolve(
		draft({
			revision: 2,
			chapters: {
				...emptyChapters(),
				identity: {
					status: "untouched",
					text: "",
					followups: 0,
					answers: [
						{
							id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
							text: "평소엔 차분해요.",
						},
					],
					proposal: null,
				},
			},
		}),
	);
	await h.settle();
	const interview = h.take("/api/onboarding/interview", "POST");
	h.dialog.dispatch("cancel");
	expect(interview.signal?.aborted).toBe(true);
});

test("closing with a typed answer saves it then closes", async () => {
	const h = harness();
	await openResumed(h);
	h.find("onboarding-answer").value = "별 이야기엔 말이 많아져요.";
	h.dialog.querySelectorAll("[data-close]")[0]?.click();
	const posted = await h.next(
		"/api/onboarding/drafts/12345678-1234-1234-1234-123456789abc/answer",
		"POST",
	);
	expect(posted.body).toMatchObject({
		text: "별 이야기엔 말이 많아져요.",
	});
	expect(
		h.pending.some((item) => item.path === "/api/onboarding/interview"),
	).toBe(false);
	posted.resolve(
		draft({
			revision: 2,
			chapters: {
				...emptyChapters(),
				identity: {
					status: "untouched",
					text: "",
					followups: 0,
					answers: [
						{
							id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
							text: "별 이야기엔 말이 많아져요.",
						},
					],
					proposal: null,
				},
			},
		}),
	);
	for (let i = 0; i < 20; i++) {
		await h.settle();
		if (!h.dialog.open) break;
	}
	expect(h.dialog.open).toBe(false);
});

test("stale extension notice asks for chapter re-review", async () => {
	const h = harness();
	await openResumed(h, draft({ staleExtension: true }));
	expect(h.find("onboarding-stale").textContent).toContain("다시 확인");
});

test("resumed target initializes shareUser from sharedAgentIds", async () => {
	const h = harness();
	await openResumed(
		h,
		draft({ targetAgentId: "lina" }),
		user({
			confirmed: {
				answers: emptyUserAnswers(),
				confirmedAt: 1,
				currentFocusExpiresAt: 9,
			},
			sharedAgentIds: ["lina"],
		}),
	);
	h.find("onboarding-primary").click();
	await h.settle();
	h.find("onboarding-primary").click();
	const patch = h.pending.find((item) => item.method === "PATCH");
	if (patch) {
		patch.resolve(draft({ targetAgentId: "lina", revision: 2 }));
		h.pending.splice(h.pending.indexOf(patch), 1);
	}
	await h.settle();
	expect(h.find("onboarding-share-user").checked).toBe(true);
});

test("new drafts do not start with shareUser", async () => {
	const h = harness();
	await openResumed(h, draft({ targetAgentId: null }));
	h.find("onboarding-primary").click();
	await h.settle();
	h.find("onboarding-primary").click();
	const patch = h.pending.find((item) => item.method === "PATCH");
	if (patch) {
		patch.resolve(draft({ revision: 2 }));
		h.pending.splice(h.pending.indexOf(patch), 1);
	}
	await h.settle();
	expect(h.find("onboarding-share-user").checked).toBe(false);
});

test("sharing and reopening preserve a newer unconfirmed introduction draft", async () => {
	const h = harness();
	const account = user({
		draft: { ...emptyUserAnswers(), address: "새 소개" },
		confirmed: {
			answers: { ...emptyUserAnswers(), address: "확인된 옛 소개" },
			confirmedAt: 1,
			currentFocusExpiresAt: 9,
		},
	});
	const opened = h.wizard.open({ source: "add" });
	h.take("/api/onboarding").resolve({ user: account, drafts: [] });
	await opened;
	h.action("share-agent");
	const share = h.take("/api/onboarding/user", "PATCH");
	expect(share.body).toMatchObject({ answers: account.draft, confirm: false });
	share.resolve({ ...account, revision: 2 });
	await h.settle();
	h.action("edit-user");
	expect(h.find("onboarding-user-address").value).toBe("새 소개");
	h.find("onboarding-save").click();
	const saved = h.take("/api/onboarding/user", "PATCH");
	saved.resolve({ ...account, revision: 3 });
	await h.settle();
	expect(h.find("onboarding-user-address").value).toBe("새 소개");
});

test("opening another draft resets failed-answer state before its first answer", async () => {
	const h = harness();
	const first = draft();
	await openResumed(h, first);
	h.find("onboarding-answer").value = "첫 캐릭터 답변";
	h.action("send-answer");
	h.take(`/api/onboarding/drafts/${first.id}/answer`, "POST").resolve({
		...first,
		revision: 2,
		chapters: {
			...emptyChapters(),
			identity: {
				...emptyChapters().identity,
				answers: [
					{
						id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
						text: "첫 캐릭터 답변",
					},
				],
			},
		},
	});
	await h.settle();
	h.take("/api/onboarding/interview", "POST").reject(
		new OnboardingHttpError(502, "failed", null),
	);
	await h.settle();
	await h.wizard.dismiss();
	const second = draft({
		id: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
		profile: profile("agent-other", "다른 캐릭터"),
	});
	await openResumed(h, second);
	expect(h.find("onboarding-answer").value).toBe("");
	expect(h.find("onboarding-chapter-text").value).toBe("");
	h.find("onboarding-answer").value = "다른 캐릭터 답변";
	h.action("send-answer");
	const posted = h.take(`/api/onboarding/drafts/${second.id}/answer`, "POST");
	expect(posted.body).toMatchObject({ text: "다른 캐릭터 답변", revision: 1 });
	posted.reject(new OnboardingHttpError(502, "failed", null));
	await h.settle();
});
