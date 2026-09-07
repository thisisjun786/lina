import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { AgentStore } from "../../lina-core/src/agents/store.ts";
import type { DurableStore } from "../../lina-core/src/store.ts";
import { entry, Fixture } from "../../lina-core/test/fixture.ts";
import type { ContextServices } from "../src/context/port.ts";
import { readPresets } from "../src/fleet/presets.ts";
import type { LinaHost } from "../src/host.ts";
import {
	FIRST_ORDINARY_REPLY_HEADER,
	firstOrdinaryReplyInstructions,
	LINA_PRODUCT_USES,
} from "../src/persona/first-conversation.ts";
import { installPersona } from "../src/persona/hooks.ts";

const productPrompt = readFileSync("data/app-system-prompt.md", "utf8");

function assemble(store: DurableStore, userContext = "", base = productPrompt) {
	const agents = new AgentStore(":memory:");
	const seed = readPresets(process.cwd())[0];
	if (!seed) throw Error("seed missing");
	agents.create(seed);
	const handlers = new Map<string, () => { systemPrompt: string }>();
	const host = {
		on: (name: string, fn: () => { systemPrompt: string }) =>
			handlers.set(name, fn),
		registerTool: () => {},
	} as unknown as LinaHost;
	const services = {
		systemTokens: 0,
		estimateText: (text: string) => text.length,
	} as ContextServices;
	installPersona(host, agents, seed.id, base, services, {
		userContext: () => userContext,
		firstOrdinaryReply: () => !store.hasNormalAssistantReply(),
	});
	return {
		agents,
		seed,
		prompt: () => handlers.get("before_agent_start")?.().systemPrompt ?? "",
	};
}

describe("first ordinary reply prompt", () => {
	const fixtures: Fixture[] = [];
	afterEach(() => {
		for (const fixture of fixtures.splice(0).reverse()) fixture.close();
	});
	function store() {
		const fixture = new Fixture();
		fixtures.push(fixture);
		return fixture.store();
	}

	test("global product context stays in the shared prompt and is not a first-reply script", () => {
		expect(productPrompt).toContain("ongoing conversation");
		expect(productPrompt).toContain("authorized work");
		expect(productPrompt).toContain("source-backed memory");
		expect(productPrompt).toContain("optional personal copies");
		expect(productPrompt).toContain("not already here as a team");
		expect(productPrompt).toContain("generic chatbot");
		expect(productPrompt).not.toContain(FIRST_ORDINARY_REPLY_HEADER);
		expect(productPrompt).toContain(
			"## 8. Delegate development and retain responsibility",
		);
	});

	test("first-reply helper uses confirmed context only when shared and keeps real examples", () => {
		const shared = firstOrdinaryReplyInstructions({
			userContext: "SELF REPORT: 예시",
		});
		const absent = firstOrdinaryReplyInstructions({ userContext: "" });
		expect(shared).toContain(FIRST_ORDINARY_REPLY_HEADER);
		expect(shared).toContain("Confirmed user self-report is present");
		expect(absent).toContain("No confirmed user self-report is shared");
		expect(absent).toContain("Do not invent");
		expect(shared).toContain("do that first");
		expect(shared).toContain("at most one relevant next question");
		expect(shared).toContain("optional personal copies");
		for (const use of LINA_PRODUCT_USES) expect(shared).toContain(use.example);
		expect(shared).not.toContain("lina_develop_start");
	});

	test("hook injects first-reply guidance for a greeting after the user entry exists", () => {
		const journal = store();
		journal.appendEntry(
			entry("hello", { role: "user", text: "헬로리나", raw: { id: "hello" } }),
		);
		const session = assemble(journal, "SELF REPORT: 예시");
		try {
			const prompt = session.prompt();
			expect(journal.hasNormalAssistantReply()).toBe(false);
			expect(prompt).toContain(FIRST_ORDINARY_REPLY_HEADER);
			expect(prompt).toContain("Confirmed user self-report is present");
			expect(prompt).toContain(session.seed.name);
			expect(prompt).toContain("optional personal copies");
			expect(prompt).toContain("ongoing conversation");
		} finally {
			session.agents.close();
		}
	});

	test("failed drafts and notices keep first-reply eligibility; a later reply and restart do not", () => {
		const journal = store();
		journal.appendEntry(entry("hello", { role: "user", text: "헬로리나" }));
		journal.appendEntry(
			entry("notice", {
				raw: { type: "custom_message", customType: "lina.development" },
			}),
		);
		journal.appendEntry(
			entry("tool-use", { raw: { message: { stopReason: "toolUse" } } }),
		);
		const first = assemble(journal);
		try {
			expect(first.prompt()).toContain(FIRST_ORDINARY_REPLY_HEADER);
			expect(first.prompt()).toContain(
				"No confirmed user self-report is shared",
			);
		} finally {
			first.agents.close();
		}
		journal.appendEntry(
			entry("reply", {
				text: "헬로! 반가워요.",
				raw: {
					type: "message",
					message: {
						role: "assistant",
						stopReason: "stop",
						content: [{ type: "text", text: "헬로! 반가워요." }],
					},
				},
			}),
		);
		const restarted = assemble(journal, "SELF REPORT: 예시");
		try {
			const prompt = restarted.prompt();
			expect(prompt).not.toContain(FIRST_ORDINARY_REPLY_HEADER);
			expect(prompt).toContain("ongoing conversation");
			expect(prompt).toContain("optional personal copies");
			expect(prompt).toContain("SELF REPORT: 예시");
		} finally {
			restarted.agents.close();
		}
	});
});
