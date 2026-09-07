import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readCodexSessionHeader } from "../../packages/lina-codex/src/identity.ts";
import type { CodexSession } from "../../packages/lina-codex/src/session.ts";
import { startCodexFleet } from "../../packages/lina-runtime/src/fleet/codex-fleet.ts";

const root = mkdtempSync(join(tmpdir(), "lina-live-e2e-"));
const options = {
	workspace: process.cwd(),
	stateRoot: root,
	port: 0,
	env: { ...process.env, LINA_MEMORY_BACKEND: "disabled" },
};
const records: unknown[] = [{ step: "state", root }];
let fleet: Awaited<ReturnType<typeof startCodexFleet>> | undefined;
async function turn(
	app: Awaited<ReturnType<NonNullable<typeof fleet>["fleet"]["app"]>>,
	text: string,
) {
	const id = randomUUID();
	let off = () => {};
	const done = new Promise<void>((resolve, reject) => {
		const timeout = setTimeout(() => {
			off();
			reject(Error("Lina turn timeout"));
		}, 60000);
		off = app.runtime.subscribe((event) => {
			if (event.type === "snapshot" && event.snapshot.state === "idle") {
				clearTimeout(timeout);
				off();
				resolve();
			}
		});
	});
	const admission = app.runtime.submit(id, text);
	records.push({ step: "admission", admission });
	await done;
	const snapshot = app.runtime.snapshot();
	assert.equal(snapshot.requests.find((r) => r.id === id)?.status, "settled");
	records.push({ step: "turn", snapshot });
	return (
		snapshot.messages.filter((m) => m.role === "assistant").at(-1)?.text ?? ""
	);
}
try {
	fleet = await startCodexFleet(options);
	fleet.fleet.modelSettings.replace(0, {
		profiles: [
			{
				id: "probe",
				provider: "opencodex",
				model: "gpt-5.6-sol",
				reasoning: "low",
			},
		],
		defaultProfileId: "probe",
		roles: {},
		agentRoles: {},
	});
	let app = await fleet.fleet.app("lina");
	const skillNames = (app.runtime.native as CodexSession).skillNames;
	assert.ok(skillNames.includes("readchk"));
	records.push({
		step: "native-skills",
		paperthinReadchkAvailable: true,
		enabledCount: skillNames.length,
	});
	const first = readCodexSessionHeader(app.binding.sessionFile, process.cwd());
	records.push({
		step: "identity",
		sessionId: app.binding.sessionId,
		nativeThreadId: first.nativeThreadId,
	});
	await turn(
		app,
		"검증용 대화야. 회의 색상은 초록으로 정했어. 도구를 호출하지 말고 LINA_APP_OK 라고만 대답해줘.",
	);
	await app.context.compact();
	records.push({
		step: "compaction-one",
		context: app.context.snapshot(),
		active: app.contextStore.active(),
	});
	await fleet.stop();
	fleet = undefined;
	fleet = await startCodexFleet(options);
	app = await fleet.fleet.app("lina");
	const second = readCodexSessionHeader(app.binding.sessionFile, process.cwd());
	assert.equal(first.nativeThreadId, second.nativeThreadId);
	assert.equal(first.id, second.id);
	records.push({ step: "resume", sameThread: true, sameLogical: true });
	assert.match(
		await turn(
			app,
			"앞에서 내가 정한 회의 색상이 뭐였지? 도구 없이 색상 한 단어로만 답해줘.",
		),
		/초록/,
	);
	await turn(
		app,
		"회의 색상은 노랑으로 바꿀게. 예전 초록은 취소야. 도구 없이 변경한 색상만 답해줘.",
	);
	await app.context.compact();
	records.push({
		step: "compaction-two",
		context: app.context.snapshot(),
		active: app.contextStore.active(),
	});
	await fleet.stop();
	fleet = undefined;
	fleet = await startCodexFleet(options);
	app = await fleet.fleet.app("lina");
	assert.match(
		await turn(
			app,
			"가장 최근에 정한 회의 색상과 그 전에 취소한 색상은? 도구 없이 최근색/취소색 형식으로만 답해줘.",
		),
		/노랑\s*\/\s*초록/,
	);
	const messages = app.runtime.snapshot().messages;
	assert.equal(messages.filter((m) => m.role === "user").length, 4);
	assert.equal(new Set(messages.map((m) => m.entryId)).size, messages.length);
	assert.ok(app.contextStore.active());
	assert.equal(app.context.snapshot().compaction.recoveryNeeded, false);
	const firstSource = messages.find((m) => m.role === "user")?.entryId;
	assert.ok(firstSource);
	assert.ok(
		app.contextStore
			.expand({ kind: "entry", id: firstSource })
			.text.includes("초록"),
	);
	assert.match(
		await turn(
			app,
			`lina_context_expand 도구를 kind=entry id=${firstSource} 로 정확히 한 번 호출해 원문을 읽어줘. 원문에서 처음 정한 회의 색상만 한 단어로 답해. 다른 도구는 쓰지 마.`,
		),
		/초록/,
	);
	const toolCalls = app.runtime.native
		.history()
		.filter(
			(entry) =>
				JSON.stringify(entry).includes('"role":"toolResult"') &&
				JSON.stringify(entry).includes("lina_context_expand"),
		);
	assert.ok(toolCalls.length > 0);
	records.push({
		step: "archive-tool",
		source: firstSource,
		actualNativeToolCalls: toolCalls.length,
		originalPreserved: true,
	});
	records.push({
		step: "restored-compaction",
		context: app.context.snapshot(),
		active: app.contextStore.active(),
	});
} catch (error) {
	records.push({
		step: "error",
		message: error instanceof Error ? error.message : "unknown",
	});
	process.exitCode = 1;
} finally {
	await fleet?.stop();
	records.push({ step: "teardown", ownedFleetStopped: true });
	await Bun.write(
		new URL(
			"../../devlog/_plan/260906_codex_runtime/050_lina_live.json",
			import.meta.url,
		),
		JSON.stringify(records, null, 2) + "\n",
	);
	console.log(JSON.stringify(records));
}
