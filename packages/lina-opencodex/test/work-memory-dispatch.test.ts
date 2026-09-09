import { expect, spyOn, test } from "bun:test";
import type { HubRequest } from "../src/client.ts";
import {
	createOpenCodexContextServices,
	createOpenCodexModelControl,
} from "../src/services.ts";
import { dispatchFixture } from "./work-memory-dispatch-fixture.ts";

const roles = [
	"authoring",
	"summarize",
	"observe",
	"reflect",
	"reasonMemory",
] as const;
type Role = (typeof roles)[number];

function invoke(
	fixture: ReturnType<typeof dispatchFixture>,
	role: Role,
	beforeDispatch?: () => void,
) {
	const signal = new AbortController().signal;
	if (role === "authoring") {
		const input = {
			agentId: "lina",
			systemPrompt: "Fixture system",
			messages: [{ role: "user" as const, content: "Fixture input" }],
			...(beforeDispatch === undefined ? {} : { beforeDispatch }),
		};
		return createOpenCodexModelControl(
			fixture.runtime,
			() => fixture.settings,
		).authoring?.(input, signal);
	}
	const services = createOpenCodexContextServices(
		fixture.runtime,
		() => fixture.settings,
	);
	if (role === "summarize")
		return services.summarize("Fixture input", 512, signal, beforeDispatch);
	return services[role]?.('{"preferencesOnly":true}', signal, beforeDispatch);
}

for (const endpoint of ["responses", "chat"] as const) {
	for (const role of roles) {
		test(`${endpoint} ${role}: source changes during final serialization reject before any fetch/HTTP`, async () => {
			const fixture = dispatchFixture(endpoint);
			const stringify = JSON.stringify;
			let revision = 1;
			const capturedRevision = revision;
			let serialized = false;
			const revoked = new Error("Frozen fixture source is stale");
			const serialize = spyOn(JSON, "stringify").mockImplementation(
				(value, replacer, space) => {
					const result =
						typeof replacer === "function"
							? stringify(value, replacer, space)
							: stringify(value, replacer, space);
					if (value?.model === "fixture-model") {
						serialized = true;
						revision++;
					}
					return result;
				},
			);
			let checks = 0;
			try {
				await expect(
					invoke(fixture, role, () => {
						checks++;
						expect(serialized).toBe(true);
						if (revision !== capturedRevision) throw revoked;
					}),
				).rejects.toBe(revoked);
				expect(checks).toBe(1);
				expect(fixture.fetchCalls).toBe(0);
				expect(fixture.requests).toHaveLength(0);
			} finally {
				serialize.mockRestore();
				await fixture.close();
			}
		});

		test(`${endpoint} ${role}: exact callback reaches final owner and never enters JSON`, async () => {
			const fixture = dispatchFixture(endpoint);
			let checks = 0;
			function guard(this: HubRequest) {
				checks++;
				expect(this.beforeDispatch).toBe(guard);
				expect(this.body).not.toHaveProperty("beforeDispatch");
				expect(fixture.fetchCalls).toBe(0);
			}
			Object.assign(guard, {
				toJSON: () => {
					throw new Error("Callback was serialized");
				},
			});
			try {
				const result = await invoke(fixture, role, guard);
				expect(typeof result === "string" ? result : result?.text).toBe(
					"local fixture answer",
				);
				expect(checks).toBe(1);
				expect(fixture.fetchCalls).toBe(1);
				expect(fixture.requests).toHaveLength(1);
				expect(fixture.requests[0]?.path).toBe(
					endpoint === "chat" ? "/v1/chat/completions" : "/v1/responses",
				);
				expect(fixture.requests[0]?.body).not.toContain("beforeDispatch");
			} finally {
				await fixture.close();
			}
		});
	}
}

for (const role of roles) {
	test(`${role}: an accidentally async guard cannot authorize dispatch`, async () => {
		const fixture = dispatchFixture();
		const release = Promise.withResolvers<void>();
		const completed = Promise.withResolvers<void>();
		try {
			await expect(
				invoke(fixture, role, async () => {
					await release.promise;
					completed.resolve();
				}),
			).rejects.toMatchObject({ code: "invalid_input" });
			expect(fixture.fetchCalls).toBe(0);
			expect(fixture.requests).toHaveLength(0);
		} finally {
			release.resolve();
			await completed.promise;
			await fixture.close();
		}
	});

	test(`${role}: existing arguments work without a guard`, async () => {
		const fixture = dispatchFixture();
		try {
			await invoke(fixture, role);
			expect(fixture.fetchCalls).toBe(1);
		} finally {
			await fixture.close();
		}
	});

	for (const malformed of [null, false, "", {}, []]) {
		test(`${role}: non-function callback ${JSON.stringify(malformed)} cannot bypass dispatch validation`, async () => {
			const fixture = dispatchFixture();
			try {
				// Deliberate malformed boundary input, outside the trusted TS contract.
				await expect(
					invoke(fixture, role, malformed as unknown as () => void),
				).rejects.toMatchObject({ code: "invalid_input" });
				expect(fixture.fetchCalls).toBe(0);
				expect(fixture.requests).toHaveLength(0);
			} finally {
				await fixture.close();
			}
		});
	}

	test(`${role}: a no-op callback does not override model validation`, async () => {
		const fixture = dispatchFixture();
		fixture.runtime.models = () => [];
		let checks = 0;
		try {
			await expect(
				invoke(fixture, role, () => {
					checks++;
				}),
			).rejects.toMatchObject({ code: "model_unavailable" });
			expect(checks).toBe(0);
			expect(fixture.fetchCalls).toBe(0);
		} finally {
			await fixture.close();
		}
	});

	test(`${role}: a failed provider response is not automatically retried`, async () => {
		const fixture = dispatchFixture();
		fixture.setStatus(503);
		let checks = 0;
		try {
			await expect(
				invoke(fixture, role, () => {
					checks++;
				}),
			).rejects.toThrow();
			expect(checks).toBe(1);
			expect(fixture.fetchCalls).toBe(1);
			expect(fixture.requests).toHaveLength(1);
		} finally {
			await fixture.close();
		}
	});
}
