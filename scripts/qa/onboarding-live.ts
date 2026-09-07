import { strict as assert } from "node:assert";
import {
	copyFileSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type {
	AgentDraft,
	UserState,
} from "../../packages/lina-core/src/onboarding/types.ts";
import { startCodexFleet } from "../../packages/lina-runtime/src/fleet/codex-fleet.ts";
import { loadWebAssets } from "../../packages/lina-web/src/assets.ts";
import { startWebServer } from "../../packages/lina-web/src/server.ts";

const root = mkdtempSync("/tmp/lina-onboarding-live-");
mkdirSync(join(root, "data/personas"), { recursive: true });
copyFileSync(
	"data/personas/presets.json",
	join(root, "data/personas/presets.json"),
);
const stateRoot = join(root, "state");
const makeFleet = async () => {
	const runtime = await startCodexFleet({
		workspace: root,
		resourceRoot: process.cwd(),
		stateRoot,
		port: 0,
		env: {
			...process.env,
			LINA_MEMORY_BACKEND: "native",
			LINA_CODEX_TASK_MODE: "owned",
		},
	});
	const instance = runtime.fleet;
	if (process.argv.includes("--trace")) {
		const authoring = instance.authoring.bind(instance);
		instance.authoring = async (input, signal) => {
			const result = await authoring(input, signal);
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
fleet.modelSettings.replace(0, {
	profiles: [
		{
			id: "direct",
			provider: "opencodex",
			model: process.env["LINA_QA_MODEL"] ?? "glm-5.3-flash",
			reasoning: "low",
		},
	],
	defaultProfileId: "direct",
	roles: {},
	agentRoles: {},
});
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
try {
	console.log(JSON.stringify({ root, base, phase: "started" }));
	if (process.argv.includes("--serve")) {
		writeFileSync(join(root, "server.json"), JSON.stringify({ root, base }));
		await new Promise<void>((resolve) => {
			process.once("SIGTERM", resolve);
			process.once("SIGINT", resolve);
		});
	} else {
		const initial = await call<{ user: UserState; drafts: AgentDraft[] }>(
			"/api/onboarding",
		);
		assert.equal(initial.user.confirmed, null);
		const answers = {
			address: "다온",
			context: "취미로 별을 관찰합니다.",
			interests: "재스민차",
			communication: "짧은 해요체",
			boundaries: "먼저 개인사를 캐묻지 않기",
			currentFocus: "이번 주 발표 준비",
		};
		let user = await call<UserState>("/api/onboarding/user", "PATCH", {
			revision: initial.user.revision,
			answers,
			sharedAgentIds: [],
			confirm: false,
		});
		assert.equal(user.confirmed, null);
		user = await call<UserState>("/api/onboarding/user", "PATCH", {
			revision: user.revision,
			answers,
			sharedAgentIds: [],
			confirm: true,
		});
		assert.deepEqual(user.confirmed?.answers, answers);
		let draft = await call<AgentDraft>("/api/onboarding/drafts", "POST", {
			targetAgentId: null,
			mode: "thoughtful",
		});
		draft = await call<AgentDraft>(
			`/api/onboarding/drafts/${draft.id}`,
			"PATCH",
			{
				revision: draft.revision,
				profile: {
					...draft.profile,
					name: "세라",
					personality: "차분하고 솔직하며 천문학 이야기에 활기를 보입니다.",
					voice:
						"자연스러운 한국어 해요체. 성격 설명을 반복하지 않고 실제 대화로 드러냅니다.",
				},
			},
		);
		draft = await call<AgentDraft>(
			`/api/onboarding/drafts/${draft.id}/answer`,
			"POST",
			{
				revision: draft.revision,
				chapter: "temperament",
				text: "평소에는 차분하지만 별과 망원경 이야기가 나오면 신나서 말이 많아지는 아이였으면 해요.",
				answerId: crypto.randomUUID(),
			},
		);
		const interview = await call<{
			draft: AgentDraft;
			question: string;
			proposal: string;
		}>("/api/onboarding/interview", "POST", {
			draftId: draft.id,
			revision: draft.revision,
			chapter: "temperament",
			deepen: false,
		});
		draft = interview.draft;
		assert(interview.proposal.trim());
		assert.equal(draft.chapters.temperament.status, "proposed");
		evidence.steps.push({ interview });
		for (const chapter of [
			"identity",
			"values",
			"temperament",
			"interests",
			"relationship",
			"expression",
		] as const) {
			const text =
				chapter === "temperament"
					? interview.proposal
					: chapter === "interests"
						? "천문학과 별자리 관찰을 좋아한다. 가장 아끼는 물건의 이름은 은빛나침반이다. 사용자의 차 취향과는 별개의 자기 관심사다."
						: "";
			draft = await call<AgentDraft>(
				`/api/onboarding/drafts/${draft.id}`,
				"PATCH",
				{
					revision: draft.revision,
					chapter: {
						id: chapter,
						text,
						status: text ? "confirmed" : "deferred",
					},
				},
			);
		}
		const app = await fleet.app("lina");
		const before = readFileSync(app.binding.sessionFile, "utf8");
		const preview = await call<{
			text: string;
			provider: string;
			model: string;
		}>("/api/onboarding/preview", "POST", {
			draftId: draft.id,
			revision: draft.revision,
			shareUser: true,
			messages: [
				{
					role: "user",
					content: "네가 좋아하는 것과 가장 아끼는 물건은 뭐야?",
				},
			],
		});
		assert.equal(preview.provider, "opencodex");
		assert(preview.text.includes("은빛나침반"));
		assert.equal(readFileSync(app.binding.sessionFile, "utf8"), before);
		evidence.steps.push({ preview, sessionUnchanged: true });
		const input = {
			revision: draft.revision,
			shareUser: true,
			userRevision: user.revision,
		};
		const applied = await call<{ agentId: string }>(
			`/api/onboarding/drafts/${draft.id}/apply`,
			"POST",
			input,
		);
		const replay = await call<{ agentId: string }>(
			`/api/onboarding/drafts/${draft.id}/apply`,
			"POST",
			input,
		);
		assert.equal(replay.agentId, applied.agentId);
		assert.equal(fleet.agents.list().length, 2);
		const response = await turn(
			applied.agentId,
			"내 호칭과 내가 좋아하는 차, 네가 가장 아끼는 물건을 알려줘.",
		);
		const text = JSON.stringify(response.answer);
		assert(text.includes("다온"));
		assert(text.includes("재스민"));
		assert(text.includes("은빛나침반"));
		evidence.steps.push({ applied, response });
		await stop();
		server = await makeFleet();
		fleet = server.fleet;
		web = startWebServer({
			port: 0,
			upstream: `ws://127.0.0.1:${server.port}`,
			assets: await loadWebAssets(),
		});
		base = `http://127.0.0.1:${web.port}`;
		const restored = await call<{ user: UserState; drafts: AgentDraft[] }>(
			"/api/onboarding",
		);
		assert.deepEqual(restored.user.confirmed?.answers, answers);
		assert(restored.drafts.some((d) => d.id === draft.id));
		const resumed = await fleet.app(applied.agentId);
		assert.equal(resumed.binding.sessionId, response.sessionId);
		const next = await turn(
			applied.agentId,
			"네가 가장 아끼는 물건 이름만 말해줘.",
		);
		assert(JSON.stringify(next.answer).includes("은빛나침반"));
		evidence.steps.push({ restart: true, next, sameSession: true });
	}
} finally {
	writeFileSync(join(root, "evidence.json"), JSON.stringify(evidence, null, 2));
	await stop();
	console.log(
		JSON.stringify({ root, steps: evidence.steps.length, phase: "closed" }),
	);
}
