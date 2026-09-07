import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { DialogueRoom } from "../../lina-core/src/onboarding/dialogue-types.ts";
import { startCodexFleet } from "../src/fleet/codex-fleet.ts";

type Snapshot = { room: DialogueRoom; userRevision: number };
type Birth = { agentId: string; roomId: string };
const post = (value: unknown) => ({
	method: "POST",
	headers: { "Content-Type": "application/json" },
	body: JSON.stringify(value),
});
const options = (root: string) => ({
	workspace: resolve(import.meta.dir, "../../.."),
	stateRoot: root,
	port: 0,
	env: {},
	homeDir: root,
});
test("completed first setup cannot be started again, including after restart and skip", async () => {
	const root = mkdtempSync(join(tmpdir(), "lina-guide-once-"));
	let app = await startCodexFleet(options(root));
	const call = (path: string, body?: unknown) =>
		fetch(
			`http://127.0.0.1:${app.port}${path}`,
			body === undefined ? undefined : post(body),
		);
	try {
		const s = (await (
			await call("/api/agents/lina/intro", { kind: "user", mode: "fast" })
		).json()) as Snapshot;
		const ready = (await (
			await call("/api/agents/lina/intro/finish", {
				roomId: s.room.id,
				revision: s.room.revision,
				userRevision: s.userRevision,
				shareUser: false,
				skip: true,
			})
		).json()) as Snapshot;
		await call("/api/agents/lina/intro/choose", {
			roomId: ready.room.id,
			revision: ready.room.revision,
			userRevision: ready.userRevision,
			shareUser: false,
			birthId: crypto.randomUUID(),
			presetId: "lina",
		});
		const completed = app.fleet.introductions.get(s.room.id);
		if (!completed) throw Error("missing completed room");
		const user = app.fleet.onboarding.user();
		expect(
			(await call("/api/agents/lina/intro", { kind: "user", mode: "fast" }))
				.status,
		).toBe(409);
		expect(
			(
				await call("/api/agents/lina/intro/restart", {
					roomId: completed.id,
					revision: completed.revision,
				})
			).status,
		).toBe(409);
		expect(app.fleet.introductions.latest("lina")).toEqual(completed);
		expect(app.fleet.onboarding.user()).toEqual(user);
		await app.stop();
		app = await startCodexFleet(options(root));
		expect(
			(await call("/api/agents/lina/intro", { kind: "user", mode: "fast" }))
				.status,
		).toBe(409);
		expect(await (await call("/api/onboarding/entry")).json()).toMatchObject({
			firstUser: false,
			resume: null,
		});
	} finally {
		await app.stop();
		rmSync(root, { recursive: true, force: true });
	}
});
test("first custom choice resumes its creation session without reopening user intake", async () => {
	const root = mkdtempSync(join(tmpdir(), "lina-guide-resume-"));
	const app = await startCodexFleet(options(root));
	const call = (path: string, body?: unknown) =>
		fetch(
			`http://127.0.0.1:${app.port}${path}`,
			body === undefined ? undefined : post(body),
		);
	try {
		const s = (await (
			await call("/api/agents/lina/intro", { kind: "user", mode: "fast" })
		).json()) as Snapshot;
		const ready = (await (
			await call("/api/agents/lina/intro/finish", {
				roomId: s.room.id,
				revision: s.room.revision,
				userRevision: s.userRevision,
				shareUser: false,
				skip: true,
			})
		).json()) as Snapshot;
		const chosen = (await (
			await call("/api/agents/lina/intro/choose", {
				roomId: ready.room.id,
				revision: ready.room.revision,
				userRevision: ready.userRevision,
				shareUser: false,
				birthId: crypto.randomUUID(),
				presetId: null,
			})
		).json()) as Birth;
		expect(await (await call("/api/onboarding/entry")).json()).toMatchObject({
			firstUser: false,
			resume: { id: chosen.roomId, agentId: chosen.agentId },
		});
	} finally {
		await app.stop();
		rmSync(root, { recursive: true, force: true });
	}
});
test("Lina guides custom and template creation while only the target draft changes, including repair", async () => {
	const root = mkdtempSync(join(tmpdir(), "lina-guide-narrator-"));
	const app = await startCodexFleet(options(root));
	const call = (path: string, body?: unknown) =>
		fetch(
			`http://127.0.0.1:${app.port}${path}`,
			body === undefined ? undefined : post(body),
		);
	try {
		const lina = app.fleet.agents.get("lina");
		const calls: Array<{ agentId: string; systemPrompt: string }> = [];
		app.fleet.authoring = async (input) => {
			calls.push(input);
			return {
				provider: "test",
				model: "test",
				text:
					calls.length === 1
						? "invalid JSON"
						: JSON.stringify({
								reply: "리나예요. 어떤 동료를 만들어볼까요?",
								userUpdates: [],
								profileUpdates: { name: "새봄" },
								chapters: { identity: "봄을 기록하는 동료" },
								summary: [],
								ready: true,
							}),
			};
		};
		for (const seed of [{ presetId: null }, { templateId: "sion" }]) {
			const born = (await (
				await call("/api/agents/birth", {
					birthId: crypto.randomUUID(),
					mode: "fast",
					...seed,
				})
			).json()) as Birth;
			const snapshot = (await (
				await call(`/api/agents/${born.agentId}/intro`)
			).json()) as Snapshot;
			const original = app.fleet.agents.get(born.agentId);
			const response = await call(`/api/agents/${born.agentId}/intro/turn`, {
				roomId: born.roomId,
				revision: snapshot.room.revision,
				requestId: crypto.randomUUID(),
				text: "봄을 기록하는 새봄이라는 에이전트를 만들자",
			});
			expect(response.status).toBe(200);
			const changed = (await response.json()) as Snapshot;
			expect(changed.room.data.profile.name).toBe("새봄");
			expect(changed.room.agentId).toBe(born.agentId);
			expect(app.fleet.agents.get(born.agentId)).toEqual(original);
			expect(app.fleet.agents.get("lina")).toEqual(lina);
			expect(app.fleet.opened(born.agentId)).toBeUndefined();
		}
		expect(calls).toHaveLength(3);
		expect(calls.every((x) => x.agentId === "lina")).toBe(true);
		expect(
			calls.every((x) => x.systemPrompt.includes("Lina, the creation guide")),
		).toBe(true);
		expect(
			calls.every(
				(x) => !x.systemPrompt.includes("co-designing YOUR OWN persona"),
			),
		).toBe(true);
	} finally {
		await app.stop();
		rmSync(root, { recursive: true, force: true });
	}
});

test("rejecting a legacy optional user restart leaves its active source intact", async () => {
	const root = mkdtempSync(join(tmpdir(), "lina-guide-legacy-"));
	const app = await startCodexFleet(options(root));
	try {
		const base = `http://127.0.0.1:${app.port}/api/agents/lina/intro`;
		const started = (await (
			await fetch(base, post({ kind: "user", mode: "fast" }))
		).json()) as Snapshot;
		const legacy = app.fleet.introductions.patch(
			started.room.id,
			started.room.revision,
			{ finalization: { firstEntry: false } },
		);
		const response = await fetch(
			`${base}/restart`,
			post({ roomId: legacy.id, revision: legacy.revision }),
		);
		expect(response.status).toBe(409);
		expect(app.fleet.introductions.latest("lina")).toEqual(legacy);
		expect(
			(await fetch(base, post({ kind: "user", mode: "fast" }))).status,
		).toBe(409);
		expect(app.fleet.introductions.latest("lina")).toEqual(legacy);
	} finally {
		await app.stop();
		rmSync(root, { recursive: true, force: true });
	}
});
