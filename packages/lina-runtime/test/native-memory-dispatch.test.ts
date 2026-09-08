import { expect, spyOn, test } from "bun:test";
import { join } from "node:path";
import { ConversationStore } from "../../lina-core/src/agents/conversation.ts";
import { AgentStore } from "../../lina-core/src/agents/store.ts";
import { createOpenCodexContextServices } from "../../lina-opencodex/src/services.ts";
import { dispatchFixture } from "../../lina-opencodex/test/work-memory-dispatch-fixture.ts";
import { CompanionMemory } from "../src/context/companion.ts";
import { readPresets } from "../src/fleet/presets.ts";
import { nativePreferences } from "../src/persona/native-preferences.ts";
import { PersonaReflection } from "../src/persona/reflection.ts";
import {
	discloseNative,
	nativeEpisode,
} from "./helpers/native-memory-source.ts";
import { createRuntimeFixture } from "./runtime-fixture.ts";

for (const lane of ["observer", "preference", "reflection"] as const)
	for (const revoke of [false, true])
		test(`${lane} caller reaches final HTTP guard: revoke=${revoke}`, async () => {
			const f = createRuntimeFixture(),
				http = dispatchFixture(),
				conversations = new ConversationStore(
					join(f.root, "preferences.sqlite"),
				),
				agents = new AgentStore(join(f.root, "agents.sqlite"));
			const profile = readPresets(process.cwd()).find((p) => p.id === "lina");
			if (!profile) throw Error("missing fixture profile");
			agents.create(profile);
			const services = createOpenCodexContextServices(
				{
					...http.runtime,
					async fetchImpl(input, init) {
						const response = await http.runtime.fetchImpl(input, init);
						await response.body?.cancel();
						return Response.json({
							output_text: lane === "observer" ? "[]" : "{}",
						});
					},
				},
				() => http.settings,
			);
			const memory = new CompanionMemory({
				path: join(f.root, "memory.sqlite"),
				binding: f.runtime.binding,
				journal: f.store,
				schedule: () => () => {},
			});
			const reflection = new PersonaReflection({
				agents,
				conversations,
				agentId: "lina",
				journal: f.store,
				services,
				memory: { recall: async () => "" },
			});
			const stringify = JSON.stringify;
			let serialized = false;
			const serialize = spyOn(JSON, "stringify").mockImplementation(
				(value, replacer, space) => {
					const result =
						typeof replacer === "function"
							? stringify(value, replacer, space)
							: stringify(value, replacer, space);
					if (!serialized && value?.model === "fixture-model") {
						serialized = true;
						if (revoke) discloseNative(f.store, "ordinary");
					}
					return result;
				},
			);
			try {
				nativeEpisode(f.store, f.runtime.binding, "ordinary");
				if (lane === "observer") {
					if (!services.observe) throw Error("missing observation service");
					memory.configure(services.observe);
					await memory.refresh();
					expect(memory.mind.hasReceipt("ordinary-user")).toBe(!revoke);
				} else if (lane === "preference") {
					if (!services.reflect) throw Error("missing reflection service");
					const source = f.store.entry("ordinary-user");
					if (!source) throw Error("missing source");
					const preferences = nativePreferences(
						conversations,
						"lina",
						f.store,
						services.reflect,
					);
					const outcome = preferences.process(
						source,
						0,
						new AbortController().signal,
					);
					if (revoke) await expect(outcome).rejects.toThrow(/provenance/);
					else await outcome;
					expect(conversations.hasPreferenceReceipt("lina", "ordinary")).toBe(
						!revoke,
					);
				} else {
					reflection.settled();
					await reflection.drain();
					expect(agents.dynamics("lina").lastRequestId).toBe(
						revoke ? null : "ordinary",
					);
					expect(conversations.hasPreferenceReceipt("lina", "ordinary")).toBe(
						!revoke,
					);
				}
				expect(serialized).toBe(true);
				expect(http.fetchCalls).toBe(revoke ? 0 : 1);
				expect(http.requests).toHaveLength(revoke ? 0 : 1);
				if (!revoke)
					expect(http.requests[0]?.body).not.toContain("beforeDispatch");
			} finally {
				serialize.mockRestore();
				await reflection.close();
				await memory.close();
				agents.close();
				conversations.close();
				await http.close();
				await f.close();
			}
		});
