import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
	DialogueRoom,
	DialogueTurn,
} from "../../lina-core/src/onboarding/dialogue-types.ts";
import { introRoutes } from "../src/fleet/intro-routes.ts";
import { AgentFleet } from "../src/fleet/manager.ts";
import { startFleetServer } from "../src/fleet/server.ts";
import {
	initializeSessionFile,
	startTestApp as startPersistentApp,
} from "./fake-session-engine.ts";
import { ControlledSession } from "./runtime-fixture.ts";

test("chat onboarding persists source on failure, confirms user, chooses unnamed agent and applies a recoverable candidate", async () => {
	const root = mkdtempSync(join(tmpdir(), "lina-intro-api-"));
	let fail = false,
		calls = 0;
	const create = () =>
		new AgentFleet({
			workspace: process.cwd(),
			stateRoot: root,
			agentDir: join(root, "auth"),
			systemPrompt: "BASE",
			createApp: (o) =>
				startPersistentApp({
					...o,
					createSession: async (s) => {
						const b = initializeSessionFile(s.sessionFile, s.workspace);
						return Object.assign(
							new ControlledSession(b.sessionId, b.sessionFile),
							{
								models: {
									catalog: () => [],
									state: () => ({
										provider: "test",
										model: "one",
										settingsRevision: 0,
										error: null,
									}),
									test: async () => {
										throw Error("unused");
									},
									authoring: async (input: {
										systemPrompt: string;
										messages: { content: string }[];
									}) => {
										calls++;
										if (fail) throw Error("secret-provider-error");
										const text = input.messages.at(-1)?.content ?? "";
										return {
											provider: "test",
											model: "one",
											text: JSON.stringify({
												reply: "반가워요. 더 이야기해 볼까요?",
												userUpdates:
													text === "다온이라고 불러줘"
														? [{ field: "address", value: "다온", quote: text }]
														: [],
												profileUpdates:
													text === "너는 세라야" ? { name: "세라" } : {},
												chapters:
													text === "너는 세라야"
														? { identity: "은빛 나침반의 동반자" }
														: {},
												summary: [],
												ready: false,
											}),
										};
									},
								},
							},
						);
					},
				}),
		});
	let fleet = create();
	let server = await startFleetServer(fleet, 0, process.cwd());
	const call = (path: string, body?: unknown) =>
		fetch(`http://127.0.0.1:${server.port}${path}`, {
			method: body === undefined ? "GET" : "POST",
			...(body === undefined ? {} : { body: JSON.stringify(body) }),
			headers: { "Content-Type": "application/json" },
		});
	type Snap = {
		room: DialogueRoom;
		turns: DialogueTurn[];
		userRevision: number;
	};
	try {
		expect(await (await call("/api/onboarding/entry")).json()).toMatchObject({
			firstUser: true,
		});
		let state = (await (
			await call("/api/agents/lina/intro", { kind: "user", mode: "fast" })
		).json()) as Snap;
		expect(state.room.kind).toBe("user");
		expect(await (await call("/api/onboarding/entry")).json()).toMatchObject({
			resume: { id: state.room.id },
		});
		expect(fleet.agents.get("lina")?.revision).toBe(1);
		state = (await (
			await call("/api/agents/lina/intro/restart", {
				roomId: state.room.id,
				revision: state.room.revision,
			})
		).json()) as Snap;
		expect(await (await call("/api/onboarding/entry")).json()).toMatchObject({
			resume: { id: state.room.id },
		});

		const input = {
			roomId: state.room.id,
			revision: state.room.revision,
			requestId: crypto.randomUUID(),
			text: "다온이라고 불러줘",
		};
		fail = true;
		const bad = await call("/api/agents/lina/intro/turn", input);
		expect(bad.status).toBe(502);
		expect(await bad.text()).not.toContain("secret-provider");
		state = (await (await call("/api/agents/lina/intro")).json()) as Snap;
		expect(state.turns[0]).toMatchObject({
			text: input.text,
			status: "failed",
		});
		fail = false;
		state = (await (
			await call("/api/agents/lina/intro/turn", input)
		).json()) as Snap;
		expect(state.room.data.user.address).toBe("다온");
		await call("/api/agents/lina/intro/turn", input);
		expect(calls).toBe(2);
		expect(fleet.onboarding.user().confirmed).toBeNull();
		const actual = fleet.authoring.bind(fleet),
			entered = Promise.withResolvers<void>(),
			release = Promise.withResolvers<void>();
		fleet.authoring = async (...args) => {
			entered.resolve();
			await release.promise;
			return actual(...args);
		};
		const cancelBody = {
			roomId: state.room.id,
			revision: state.room.revision,
			requestId: crypto.randomUUID(),
			text: "계속해 볼게",
		};
		const controller = new AbortController();
		const pending = introRoutes(
			new Request("http://localhost/api/agents/lina/intro/turn", {
				method: "POST",
				signal: controller.signal,
			}),
			fleet,
			async () => cancelBody,
		);
		await entered.promise;
		expect((await call("/api/agents/lina/intro/turn", cancelBody)).status).toBe(
			409,
		);
		controller.abort();
		release.resolve();
		expect((await pending)?.status).toBe(499);
		fleet.authoring = actual;
		state = (await (await call("/api/agents/lina/intro")).json()) as Snap;
		expect(state.turns.at(-1)).toMatchObject({
			text: cancelBody.text,
			status: "failed",
			error: "cancelled",
		});
		state = (await (
			await call("/api/agents/lina/intro/turn", cancelBody)
		).json()) as Snap;
		expect(state.turns.at(-1)).toMatchObject({ status: "done", attempts: 2 });

		let repairs = 0;
		fleet.authoring = async (...args) => {
			repairs++;
			if (repairs === 1)
				return {
					provider: "test",
					model: "one",
					text: JSON.stringify({
						reply: "알겠어요.",
						userUpdates: [
							{ field: "address", value: "다온", quote: "오타 인용" },
						],
						profileUpdates: {},
						chapters: {},
						summary: [],
						ready: false,
					}),
				};
			return actual(...args);
		};
		const repaired = await call("/api/agents/lina/intro/turn", {
			roomId: state.room.id,
			revision: state.room.revision,
			requestId: crypto.randomUUID(),
			text: "다온이라고 불러줘",
		});
		expect(repaired.status).toBe(200);
		state = (await repaired.json()) as Snap;
		expect(repairs).toBe(2);
		expect(state.turns.at(-1)?.attempts).toBe(1);
		fleet.authoring = actual;
		const finish = {
			roomId: state.room.id,
			revision: state.room.revision,
			userRevision: state.userRevision,
			shareUser: true,
			skip: false,
		};
		const save = fleet.onboarding.saveUser.bind(fleet.onboarding);
		fleet.onboarding.saveUser = (...args) => {
			save(...args);
			throw Error("crash after user save");
		};
		expect((await call("/api/agents/lina/intro/finish", finish)).status).toBe(
			400,
		);
		fleet.onboarding.saveUser = save;
		state = (await (
			await call("/api/agents/lina/intro/finish", finish)
		).json()) as Snap;
		expect(state.room.status).toBe("choices");
		expect(await (await call("/api/onboarding/entry")).json()).toMatchObject({
			resume: { id: state.room.id },
		});
		await call("/api/agents/lina/intro/finish", finish);
		expect(fleet.onboarding.userContextFor("lina")).toContain("다온");
		const choose = {
			roomId: state.room.id,
			revision: state.room.revision,
			userRevision: state.userRevision,
			presetId: null,
			birthId: crypto.randomUUID(),
			shareUser: true,
		};
		const chosen = (await (
			await call("/api/agents/lina/intro/choose", choose)
		).json()) as { agentId: string; roomId: string };
		expect(chosen.agentId).toStartWith("agent-");
		expect(
			await (await call("/api/agents/lina/intro/choose", choose)).json(),
		).toMatchObject(chosen);
		expect(fleet.agents.list()).toHaveLength(2);
		state = (await (
			await call(`/api/agents/${chosen.agentId}/intro`)
		).json()) as Snap;
		state = (await (
			await call(`/api/agents/${chosen.agentId}/intro/turn`, {
				roomId: state.room.id,
				revision: state.room.revision,
				requestId: crypto.randomUUID(),
				text: "너는 세라야",
			})
		).json()) as Snap;
		expect(fleet.agents.get(chosen.agentId)?.name).not.toBe("세라");
		const personaFinish = {
			roomId: state.room.id,
			revision: state.room.revision,
			userRevision: state.userRevision,
			shareUser: true,
			skip: false,
		};
		const done = await call(
			`/api/agents/${chosen.agentId}/intro/finish`,
			personaFinish,
		);
		expect(done.status).toBe(200);
		expect(fleet.agents.get(chosen.agentId)?.name).toBe("세라");
		expect(
			await (await call("/api/agents/lina/intro/choose", choose)).json(),
		).toMatchObject({
			agentId: chosen.agentId,
			roomId: null,
			url: `/?agent=${chosen.agentId}`,
		});
		expect(fleet.opened(chosen.agentId)).toBeUndefined();
		const sid = (await fleet.app(chosen.agentId)).binding.sessionId;
		await server.stop();
		await fleet.close();
		fleet = create();
		server = await startFleetServer(fleet, 0, process.cwd());
		expect((await fleet.app(chosen.agentId)).binding.sessionId).toBe(
			sid ?? "missing",
		);
		expect(fleet.onboarding.userContextFor(chosen.agentId)).toContain("다온");
		expect(fleet.onboarding.authoredContextFor(chosen.agentId, 2)).toContain(
			"은빛 나침반",
		);
		state = (await (
			await call(`/api/onboarding/rooms/${chosen.roomId}`)
		).json()) as Snap;
		expect(state.turns[0]?.text).toBe("너는 세라야");
		expect(await (await call("/api/onboarding/entry")).json()).toMatchObject({
			firstUser: false,
			resume: null,
		});

		expect(
			(await call("/api/agents/lina/intro", { kind: "user", mode: "fast" }))
				.status,
		).toBe(409);
		expect(await (await call("/api/onboarding/entry")).json()).toMatchObject({
			firstUser: false,
			resume: null,
		});
		let legacy = fleet.onboarding.createDraft(
			{ targetAgentId: null, mode: "fast" },
			{ agents: fleet.agents, presets: fleet.presets, existingCount: 2 },
		);
		legacy = fleet.onboarding.patchDraft(legacy.id, {
			revision: legacy.revision,
			profile: { ...legacy.profile, name: "별빛" },
		});
		const born = (await (
			await call("/api/agents/birth", {
				birthId: crypto.randomUUID(),
				presetId: null,
				mode: "fast",
				draftId: legacy.id,
			})
		).json()) as { agentId: string; roomId: string };
		let seeded = (await (
			await call(`/api/agents/${born.agentId}/intro`)
		).json()) as Snap;
		expect(seeded.room.data.profile.name).toBe("별빛");
		expect(fleet.onboarding.getDraft(legacy.id)).toEqual(legacy);
		expect(fleet.agents.get(born.agentId)?.name).not.toBe("별빛");
		const apply = fleet.onboarding.applyDraft.bind(fleet.onboarding);
		fleet.onboarding.applyDraft = () => {
			throw Error("stale profile revision");
		};
		expect(
			(
				await call(`/api/agents/${born.agentId}/intro/finish`, {
					roomId: seeded.room.id,
					revision: seeded.room.revision,
					userRevision: seeded.userRevision,
					shareUser: false,
					skip: false,
				})
			).status,
		).toBe(409);
		fleet.onboarding.applyDraft = apply;
		seeded = (await (
			await call(`/api/agents/${born.agentId}/intro`)
		).json()) as Snap;
		expect(seeded.room.status).toBe("applying");
		const fresh = (await (
			await call(`/api/agents/${born.agentId}/intro/restart`, {
				roomId: seeded.room.id,
				revision: seeded.room.revision,
			})
		).json()) as Snap;
		expect(fresh.room.status).toBe("active");
		expect(fresh.room.draftId).not.toBe(seeded.room.draftId);
		expect(fleet.introductions.get(seeded.room.id)?.data.profile.name).toBe(
			"별빛",
		);
	} finally {
		await server.stop();
		await fleet.close();
		rmSync(root, { recursive: true, force: true });
	}
});
