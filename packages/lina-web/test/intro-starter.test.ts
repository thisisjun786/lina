import { expect, test } from "bun:test";
import presets from "../../../data/personas/presets.json";
import { validateAgentInput } from "../../lina-core/src/agents/validation.ts";
import { unspecifiedProfile } from "../../lina-core/src/onboarding/helpers.ts";
import type { IntroRoom } from "../client/intro-types.ts";
import { type IntroNode, renderPanel } from "../client/intro-view.ts";

class Node implements IntroNode {
	textContent: string | null = "";
	hidden = false;
	disabled = false;
	value = "";
	id = "";
	className = "";
	children: Node[] = [];
	attrs = new Map<string, string>();
	append(...nodes: IntroNode[]) {
		this.children.push(...(nodes as Node[]));
	}
	replaceChildren(...nodes: IntroNode[]) {
		this.children = [];
		this.append(...nodes);
	}
	setAttribute(k: string, v: string) {
		this.attrs.set(k, v);
	}
	getAttribute(k: string) {
		return this.attrs.get(k) ?? null;
	}
	querySelector() {
		return null;
	}
	querySelectorAll() {
		return [];
	}
	addEventListener() {}
	click() {}
	focus() {}
	all(): Node[] {
		return [this, ...this.children.flatMap((n) => n.all())];
	}
}
const room: IntroRoom = {
	id: crypto.randomUUID(),
	agentId: "lina",
	kind: "user",
	status: "choices",
	revision: 1,
	mode: "fast",
	draftId: null,
	createdAt: 1,
	finalization: null,
	data: {
		profile: unspecifiedProfile("lina"),
		chapters: {
			identity: "",
			values: "",
			temperament: "",
			interests: "",
			relationship: "",
			expression: "",
		},
		user: {},
		summary: [],
		ready: false,
	},
};
const render = (current: IntroRoom) => {
	const panel = new Node();
	renderPanel(
		panel,
		{ createElement: () => new Node(), getElementById: () => null },
		{
			snapshot: {
				room: current,
				turns: [],
				userRevision: 0,
				shareUser: false,
				presets: presets.map(validateAgentInput),
				sessionId: null,
			},
			reviewOpen: false,
			entry: null,
			busy: false,
		},
	);
	return panel.all();
};
test("first-run choice offers only Lina or a personal agent, never the later domain roster", () => {
	const nodes = render(room);
	const choices = nodes.filter((n) =>
		["choose", "choose-custom"].includes(
			n.getAttribute("data-intro-action") ?? "",
		),
	);
	expect(choices).toHaveLength(2);
	expect(
		choices
			.filter((n) => n.getAttribute("data-preset-id"))
			.map((n) => n.getAttribute("data-preset-id")),
	).toEqual(["lina"]);
	expect(nodes.map((n) => n.textContent)).toContain("리나로 시작");
	expect(nodes.map((n) => n.textContent)).toContain("내 에이전트 만들기");
});
test("incomplete introduction invites inspection without implying it is already finished", () => {
	const nodes = render({ ...room, status: "active" });
	const review = nodes.find(
		(n) => n.getAttribute("data-intro-action") === "review",
	);
	expect(review?.textContent).toBe("현재 소개 보기");
	expect(review?.className).toBe("text-button");
	expect(
		nodes.some((n) => n.getAttribute("data-intro-action") === "skip"),
	).toBe(true);
});

test("completed setup has no return or restart controls", () => {
	const nodes = render({ ...room, status: "done" });
	expect(nodes.some((n) => n.getAttribute("data-intro-action"))).toBe(false);
});
test("agent creation review describes the agent being created", () => {
	const nodes = render({ ...room, kind: "persona", status: "active" });
	expect(
		nodes.find((n) => n.getAttribute("data-intro-action") === "review")
			?.textContent,
	).toBe("만들 에이전트 보기");
});
