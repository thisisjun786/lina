import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CompanionMemory } from "../../packages/lina-runtime/src/context/companion.ts";
import { AgentFleet } from "../../packages/lina-runtime/src/fleet/manager.ts";
import { startFleetServer } from "../../packages/lina-runtime/src/fleet/server.ts";
import {
	initializeSessionFile,
	startTestApp,
} from "../../packages/lina-runtime/test/fake-session-engine.ts";
import { ControlledSession } from "../../packages/lina-runtime/test/runtime-fixture.ts";
import { loadWebAssets } from "../../packages/lina-web/src/assets.ts";
import { startWebServer } from "../../packages/lina-web/src/server.ts";

const root = mkdtempSync(join(tmpdir(), "lina-companion-preview-"));
const fleet = new AgentFleet({
	workspace: process.cwd(),
	stateRoot: root,
	agentDir: join(root, "auth"),
	systemPrompt: "Synthetic QA only. No external provider.",
	memoryBackend: "native",
	createApp: (o) =>
		startTestApp({
			...o,
			createSession: async (s) => {
				const b = initializeSessionFile(s.sessionFile, s.workspace);
				const native = new ControlledSession(b.sessionId, b.sessionFile);
				return Object.assign(native, {
					models: {
						catalog: () => [
							{
								provider: "synthetic",
								id: "dialogue",
								name: "대화 시험 모델",
								contextWindow: 96000,
								maxOutputTokens: 4096,
								reasoning: true,
								authenticated: true,
							},
							{
								provider: "synthetic",
								id: "observer",
								name: "기억 시험 모델",
								contextWindow: 64000,
								maxOutputTokens: 2048,
								reasoning: false,
								authenticated: true,
							},
						],
						state: () => ({
							provider: "synthetic",
							model: "dialogue",
							settingsRevision: 0,
							error: null,
						}),
						test: async () => ({
							provider: "synthetic",
							model: "dialogue",
							text: "격리된 시험 응답입니다.",
							inputTokens: 12,
							outputTokens: 8,
							durationMs: 4,
						}),
					},
				});
			},
		}),
});
const kai = fleet.presets.find((p) => p.id === "kai");
if (kai) fleet.agents.create(kai);
const lina = await fleet.app("lina");
lina.runtime.store.appendEntry({
	entryId: "synthetic-user",
	role: "user",
	text: "요즘 발표 준비가 고민이야.",
	timestamp: new Date().toISOString(),
	raw: {},
});
if (lina.memory instanceof CompanionMemory)
	lina.memory.mind.apply({
		requestId: "qa",
		expectedRevision: 0,
		observations: [
			{
				subject: "user",
				kind: "concern",
				key: "presentation",
				text: "발표 준비를 고민하고 있음",
				evidence: "explicit",
				sources: [{ entryId: "synthetic-user", quote: "발표 준비가 고민" }],
			},
			{
				subject: "self",
				kind: "mood",
				key: "curiosity",
				text: "발표 주제가 궁금함",
				evidence: "inferred",
				sources: [{ entryId: "synthetic-user", quote: "발표 준비" }],
			},
		],
	});
const controller = await startFleetServer(fleet, 0, process.cwd());
const web = startWebServer({
	port: 0,
	upstream: `ws://127.0.0.1:${controller.port}`,
	assets: await loadWebAssets(),
});
console.log(
	JSON.stringify({
		url: `http://127.0.0.1:${web.port}`,
		root,
		controller: controller.port,
	}),
);
let stopped = false;
const stop = async () => {
	if (stopped) return;
	stopped = true;
	await web.stop(true);
	await controller.stop();
	process.exit(0);
};
process.once("SIGTERM", () => void stop());
process.once("SIGINT", () => void stop());
