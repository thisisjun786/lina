import { expect, test } from "bun:test";
import { AgentStore } from "../../lina-core/src/agents/store.ts";
import type { ContextServices } from "../src/context/port.ts";
import { readPresets } from "../src/fleet/presets.ts";
import type { LinaHost } from "../src/host.ts";
import { installPersona } from "../src/persona/hooks.ts";

test("confirmed onboarding context refreshes per turn with budgets and core unchanged", () => {
	const agents = new AgentStore(":memory:");
	const seed = readPresets(process.cwd())[0];
	if (!seed) throw Error("seed missing");
	agents.create(seed);
	let user = "SELF REPORT: likes jasmine";
	const authored = "APPROVED DETAIL " + "성격의 세부 맥락 ".repeat(200);
	let hook: (() => { systemPrompt: string }) | undefined;
	const host = {
		on: (_n: string, f: typeof hook) => {
			hook = f;
		},
		registerTool: () => {},
	} as unknown as LinaHost;
	const services = {
		systemTokens: 0,
		estimateText: (text: string) => text.length,
	} as ContextServices;
	try {
		installPersona(host, agents, seed.id, "BASE", services, {
			userContext: () => user,
			authoredContext: () => authored,
		});
		if (!hook) throw Error("hook missing");
		const initial = hook().systemPrompt;
		expect(initial).toContain(authored);
		expect(initial).toContain(user);
		expect(initial).toContain(seed.personality);
		expect(services.systemTokens).toBe(initial.length);
		user = "";
		expect(hook().systemPrompt).not.toContain("likes jasmine");
		expect(agents.get(seed.id)?.revision).toBe(1);
	} finally {
		agents.close();
	}
});
