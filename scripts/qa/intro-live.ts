import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type {
	DialogueRoom,
	DialogueTurn,
} from "../../packages/lina-core/src/onboarding/dialogue-types.ts";

import { startCodexFleet } from "../../packages/lina-runtime/src/fleet/codex-fleet.ts";
import { loadWebAssets } from "../../packages/lina-web/src/assets.ts";
import { startWebServer } from "../../packages/lina-web/src/server.ts";

const recoverRoot = process.argv
	.find((a) => a.startsWith("--recover-root="))
	?.slice("--recover-root=".length);
if (
	recoverRoot &&
	!/^\/tmp\/lina-onboarding-live-[a-zA-Z0-9]+$/.test(recoverRoot)
)
	throw Error("QA temporary root only");
const serveRoot = process.argv
	.find((a) => a.startsWith("--serve-root="))
	?.slice("--serve-root=".length);
if (serveRoot && !/^\/tmp\/lina-onboarding-live-[a-zA-Z0-9]+$/.test(serveRoot))
	throw Error("QA temporary root only");
const root =
	recoverRoot ?? serveRoot ?? mkdtempSync("/tmp/lina-onboarding-live-");
const resourceRoot = resolve(import.meta.dir, "../..");
const stateRoot = join(root, "state");
const workspaceRoot = join(root, "workspaces");
mkdirSync(workspaceRoot, { recursive: true });
mkdirSync(join(root, "skills"), { recursive: true });
const makeFleet = async () => {
	const runtime = await startCodexFleet({
		workspace: workspaceRoot,
		workspaceRoot,
		resourceRoot,
		stateRoot,
		port: 0,
		env: {
			...process.env,
			LINA_MEMORY_BACKEND: "native",
			LINA_CODEX_TASK_MODE: "owned",
			LINA_CODEX_SKILL_ROOTS: join(root, "skills"),
		},
	});
	const instance = runtime.fleet;
	if (
		instance.modelSettings.snapshot().revision === 0 &&
		!process.argv.includes("--unconfigured")
	) {
		const model = process.env["LINA_QA_MODEL"] ?? "gpt-5.6-luna";
		if (!runtime.hub.catalog().some((item) => item.id === model)) {
			await runtime.stop();
			throw Error("QA model is not in connected Hub catalog");
		}
		instance.modelSettings.replace(0, {
			profiles: [{ id: "qa", provider: "opencodex", model, reasoning: "low" }],
			defaultProfileId: "qa",
			roles: {},
			agentRoles: {},
		});
	}
	if (process.argv.includes("--trace")) {
		const authoring = instance.authoring.bind(instance);
		instance.authoring = async (input, signal) => {
			let result: Awaited<ReturnType<typeof authoring>>;
			try {
				result = await authoring(input, signal);
			} catch (error) {
				writeFileSync(
					join(root, `authoring-error-${crypto.randomUUID()}.json`),
					JSON.stringify({
						error: error instanceof Error ? error.message : "unknown",
						code:
							error && typeof error === "object" && "code" in error
								? error.code
								: null,
					}),
					{ mode: 0o600 },
				);
				throw error;
			}
			writeFileSync(
				join(root, `authoring-${crypto.randomUUID()}.json`),
				JSON.stringify({ input, result }),
				{ mode: 0o600 },
			);
			return result;
		};
	}
	return runtime;
};
let server = await makeFleet();
let fleet = server.fleet;
let web = startWebServer({
	port: 0,
	upstream: `ws://127.0.0.1:${server.port}`,
	assets: await loadWebAssets(),
});
let base = `http://127.0.0.1:${web.port}`;
const evidence: { root: string; steps: unknown[] } = { root, steps: [] };
async function call<T>(
	path: string,
	method = "GET",
	body?: unknown,
): Promise<T> {
	const response = await fetch(base + path, {
		method,
		headers: { Origin: base, "Content-Type": "application/json" },
		...(body === undefined ? {} : { body: JSON.stringify(body) }),
		signal: AbortSignal.timeout(80000),
	});
	const text = await response.text();
	if (!response.ok)
		throw Error(`${path} HTTP${response.status}: ${text.slice(0, 500)}`);
	const value: unknown = JSON.parse(text);
	return value as T;
}
async function stop() {
	await web.stop(true);
	await server.stop();
	await fleet.close();
}
async function turn(agentId: string, prompt: string) {
	const app = await fleet.app(agentId);
	const done = Promise.withResolvers<void>();
	const id = crypto.randomUUID();
	const off = app.runtime.subscribe((event) => {
		if (event.type !== "snapshot") return;
		const request = event.snapshot.requests.find((r) => r.id === id);
		if (request?.status === "settled") done.resolve();
		else if (request && ["rejected", "interrupted"].includes(request.status))
			done.reject(Error(request.status));
	});
	try {
		app.runtime.submit(id, prompt);
		await Promise.race([
			done.promise,
			new Promise<never>((_, reject) =>
				AbortSignal.timeout(90000).addEventListener(
					"abort",
					() => reject(Error("turn timeout")),
					{ once: true },
				),
			),
		]);
	} finally {
		off();
	}
	const entries = app.runtime.native.history() as {
		message?: { role?: string; content?: unknown };
	}[];
	const content = entries.filter((e) => e.message?.role === "assistant").at(-1)
		?.message?.content;
	const answer =
		typeof content === "string"
			? content
			: Array.isArray(content)
				? content
						.flatMap((part: unknown) =>
							part &&
							typeof part === "object" &&
							"type" in part &&
							part.type === "text" &&
							"text" in part &&
							typeof part.text === "string"
								? [part.text]
								: [],
						)
						.join("\n")
				: "";
	return { answer, sessionId: app.binding.sessionId };
}
type Snapshot = {
	room: DialogueRoom;
	turns: DialogueTurn[];
	userRevision: number;
};
async function say(state: Snapshot, text: string | null): Promise<Snapshot> {
	const next = await call<Snapshot>(
		`/api/agents/${state.room.agentId}/intro/turn`,
		"POST",
		{
			roomId: state.room.id,
			revision: state.room.revision,
			requestId: crypto.randomUUID(),
			text,
		},
	);
	evidence.steps.push({
		kind: next.room.kind,
		text,
		reply: next.turns.at(-1)?.reply,
		data: next.room.data,
		revision: next.room.revision,
	});
	return next;
}
try {
	console.log(JSON.stringify({ root, base, phase: "started" }));
	if (recoverRoot) {
		const state = await call<Snapshot>("/api/agents/lina/intro");
		const failed = state.turns.find((t) => t.status === "failed");
		assert.ok(failed);
		const next = await call<Snapshot>("/api/agents/lina/intro/turn", "POST", {
			roomId: state.room.id,
			revision: state.room.revision,
			requestId: failed.requestId,
			text: failed.text,
		});
		assert.equal(next.turns.length, state.turns.length);
		assert.equal(next.turns.at(-1)?.status, "done");
		assert.equal(next.turns.at(-1)?.attempts, failed.attempts + 1);
		assert.equal(next.turns.at(-1)?.text, failed.text);
		evidence.steps.push({
			kind: "actual-provider-failed-turn-recovered",
			before: failed,
			after: next.turns.at(-1),
			data: next.room.data,
		});
	} else if (process.argv.includes("--serve")) {
		writeFileSync(join(root, "server.json"), JSON.stringify({ root, base }));
		await new Promise<void>((resolve) => {
			process.once("SIGTERM", resolve);
			process.once("SIGINT", resolve);
		});
	} else {
		assert.equal(
			(await call<{ firstUser: boolean }>("/api/onboarding/entry")).firstUser,
			true,
		);
		let state = await call<Snapshot>("/api/agents/lina/intro", "POST", {
			kind: "user",
			mode: "fast",
		});
		state = await say(state, null);
		state = await say(
			state,
			"다온이라고 불러줘. 나는 작은 서점을 운영하고, 재스민차와 사진 산책을 좋아해. 오늘은 이사 준비 때문에 조금 지쳤어. 짧고 담백하게 말해주면 편해.",
		);
		assert.match(state.room.data.user.address ?? "", /다온/);
		assert.match(state.room.data.user.currentFocus ?? "", /이사|지쳤|피곤/);
		state = await say(
			state,
			"정정할게. 서점 운영은 예시로 한 말이야. 직업 정보는 지워줘. 나머지는 맞아. 여기까지만 소개하고 비서를 골라볼래.",
		);
		assert.equal(state.room.data.user.context ?? "", "");
		state = await call<Snapshot>("/api/agents/lina/intro/finish", "POST", {
			roomId: state.room.id,
			revision: state.room.revision,
			userRevision: state.userRevision,
			shareUser: true,
			skip: false,
		});
		const lina = await turn(
			"lina",
			"내 호칭과 좋아하는 차가 뭐였지? 한 문장으로 답해줘.",
		);
		assert.match(lina.answer, /다온/);
		assert.match(lina.answer, /재스민/);
		evidence.steps.push({ kind: "lina-codex", ...lina });
		const selected = await call<{ agentId: string; roomId: string }>(
			"/api/agents/lina/intro/choose",
			"POST",
			{
				roomId: state.room.id,
				revision: state.room.revision,
				userRevision: state.userRevision,
				presetId: null,
				birthId: crypto.randomUUID(),
				shareUser: true,
			},
		);
		state = await call<Snapshot>(`/api/agents/${selected.agentId}/intro`);
		state = await say(state, null);
		state = await say(
			state,
			"너는 세라라는 동반자면 좋겠어. 은빛 나침반을 간직한 별 관측가이고, 솔직하지만 서두르지 않는 성격이야. 독립적으로 좋아하는 건 옛 별지도 수집이야. 나랑은 서로 의견을 나누는 친구고, 갈등이 나면 뭐가 달랐는지 차분히 먼저 물어봐. 말은 짧고 담백하게. 이 정도로 첫 설정을 마칠게.",
		);
		assert.match(state.room.data.profile.name, /세라/);
		state = await call<Snapshot>(
			`/api/agents/${selected.agentId}/intro/finish`,
			"POST",
			{
				roomId: state.room.id,
				revision: state.room.revision,
				userRevision: state.userRevision,
				shareUser: true,
				skip: false,
			},
		);
		const first = await turn(
			selected.agentId,
			"내 호칭과 좋아하는 차, 그리고 네 이름과 소중히 간직한 물건을 두 문장으로 말해줘.",
		);
		assert.match(first.answer, /다온/);
		assert.match(first.answer, /재스민/);
		assert.match(first.answer, /세라/);
		assert.match(first.answer, /나침반/);
		evidence.steps.push({ kind: "custom-codex", ...first });
		const sources = fleet.introductions.turns(state.room.id);
		await stop();
		server = await makeFleet();
		fleet = server.fleet;
		web = startWebServer({
			port: 0,
			upstream: `ws://127.0.0.1:${server.port}`,
			assets: await loadWebAssets(),
		});
		base = `http://127.0.0.1:${web.port}`;
		assert.deepEqual(fleet.introductions.turns(state.room.id), sources);
		const restarted = await turn(
			selected.agentId,
			"네가 간직한 물건은? 짧게 말해줘.",
		);
		assert.equal(restarted.sessionId, first.sessionId);
		assert.match(restarted.answer, /나침반/);
		evidence.steps.push({ kind: "restart-codex", ...restarted });
		assert.equal(
			(await call<{ firstUser: boolean }>("/api/onboarding/entry")).firstUser,
			false,
		);
		evidence.steps.push({
			kind: "source-preserved",
			turns: sources.length,
			roomId: state.room.id,
			agentId: selected.agentId,
		});
	}
	writeFileSync(
		join(root, "evidence.json"),
		JSON.stringify(evidence, null, 2),
		{ mode: 0o600 },
	);
	console.log(JSON.stringify({ root, steps: evidence.steps.length, ok: true }));
} finally {
	writeFileSync(
		join(root, "evidence.json"),
		JSON.stringify(evidence, null, 2),
		{ mode: 0o600 },
	);
	await stop();
}
