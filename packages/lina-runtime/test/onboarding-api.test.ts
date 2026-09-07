import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
	AgentDraft,
	InterviewResult,
	UserState,
} from "../../lina-core/src/onboarding/types.ts";
import { AgentFleet } from "../src/fleet/manager.ts";
import { startFleetServer } from "../src/fleet/server.ts";
import {
	initializeSessionFile,
	startTestApp as startPersistentApp,
} from "./fake-session-engine.ts";
import { ControlledSession } from "./runtime-fixture.ts";

test("onboarding endpoints persist answers across provider failure and never open preview rooms", async () => {
	const root = mkdtempSync(join(tmpdir(), "lina-onboarding-api-"));
	let fail = false;
	let calls = 0;
	let observedSystem = "";
	const fleet = new AgentFleet({
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
									observedSystem = input.systemPrompt;
									if (fail) throw Error("private-provider-error");
									const last = JSON.parse(
										input.messages.at(-1)?.content ?? "{}",
									) as { answers?: { id: string }[] };
									return {
										provider: "test",
										model: "one",
										text: JSON.stringify({
											text: "평소 차분하고 별 이야기에는 활기가 있다.",
											question: "어떤 별 이야기를 좋아하나요?",
											sourceIds: last.answers?.map((a) => a.id) ?? [],
										}),
									};
								},
							},
						},
					);
				},
			}),
	});
	const server = await startFleetServer(fleet, 0, process.cwd());
	const base = `http://127.0.0.1:${server.port}`;
	async function call(path: string, method = "GET", body?: unknown) {
		return fetch(base + path, {
			method,
			...(body === undefined ? {} : { body: JSON.stringify(body) }),
			headers: { "Content-Type": "application/json" },
		});
	}
	try {
		const get = await call("/api/onboarding");
		expect(get.status).toBe(200);
		const initial = (await get.json()) as { user: UserState };
		expect(initial.user.confirmed).toBeNull();
		let draft = (await (
			await call("/api/onboarding/drafts", "POST", {
				targetAgentId: null,
				mode: "thoughtful",
			})
		).json()) as AgentDraft;
		draft = fleet.onboarding.patchDraft(draft.id, {
			revision: draft.revision,
			profile: {
				...draft.profile,
				name: "SeraAuthoringReference",
				personality: "서두르지 않고 근거를 살핍니다.",
			},
		});
		const answerId = crypto.randomUUID();
		draft = (await (
			await call(`/api/onboarding/drafts/${draft.id}/answer`, "POST", {
				revision: draft.revision,
				chapter: "temperament",
				text: "차분하지만 별 이야기에 활기를 보여요.",
				answerId,
			})
		).json()) as AgentDraft;
		fail = true;
		const body = {
			draftId: draft.id,
			revision: draft.revision,
			chapter: "temperament",
			deepen: false,
		};
		const bad = await call("/api/onboarding/interview", "POST", body);
		expect(bad.status).toBe(502);
		expect(await bad.text()).not.toContain("private-provider-error");
		const persisted = (await (await call("/api/onboarding")).json()) as {
			drafts: AgentDraft[];
		};
		expect(persisted.drafts[0]?.chapters.temperament.answers[0]?.id).toBe(
			answerId,
		);
		expect(persisted.drafts[0]?.chapters.temperament.followups).toBe(0);
		fail = false;
		const good = await call("/api/onboarding/interview", "POST", body);
		expect(good.status).toBe(200);
		expect(observedSystem).toContain("SeraAuthoringReference");
		expect(observedSystem).toContain("서두르지 않고 근거를 살핍니다.");
		expect(observedSystem).toContain(
			"Automatic model rounds remaining after this response: 1",
		);
		const result = (await good.json()) as InterviewResult;
		expect(result.draft.chapters.temperament.status).toBe("proposed");
		expect(result.draft.chapters.temperament.followups).toBe(1);
		expect(fleet.agents.list()).toHaveLength(1);
		expect(fleet.opened(draft.profile.id)).toBeUndefined();
		expect((await call("/api/onboarding/interview", "POST", body)).status).toBe(
			409,
		);
		expect(calls).toBe(2);
		expect(
			(
				await fetch(base + "/api/onboarding", {
					headers: { Origin: "https://attacker.example" },
				})
			).status,
		).toBe(403);
	} finally {
		await server.stop();
		rmSync(root, { recursive: true, force: true });
	}
});
