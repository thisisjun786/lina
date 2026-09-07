import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { startCodexFleet } from "../src/fleet/codex-fleet.ts";

const body = (value: unknown) => ({
	method: "POST",
	headers: { "Content-Type": "application/json" },
	body: JSON.stringify(value),
});
test("domain template creates a separate personal agent and resumes the same interview after retry/restart", async () => {
	const root = mkdtempSync(join(tmpdir(), "lina-template-"));
	const options = {
		workspace: resolve(import.meta.dir, "../../.."),
		stateRoot: root,
		port: 0,
		env: {},
		homeDir: root,
	};
	let app = await startCodexFleet(options);
	const create = (input: unknown) =>
		fetch(`http://127.0.0.1:${app.port}/api/agents/birth`, body(input));
	try {
		const legacy = await create({
			birthId: crypto.randomUUID(),
			presetId: "kai",
			mode: "fast",
		});
		expect(legacy.status).toBe(200);
		expect(await legacy.json()).toMatchObject({ agentId: "kai", roomId: null });
		const original = app.fleet.agents.get("kai");
		const preset = structuredClone(
			app.fleet.presets.find((p) => p.id === "kai"),
		);
		const input = {
			birthId: crypto.randomUUID(),
			templateId: "kai",
			mode: "fast",
		};
		const response = await create(input);
		expect(response.status).toBe(200);
		const first = (await response.json()) as {
			agentId: string;
			roomId: string;
			url: string;
		};
		expect(first.agentId).toBe(`agent-${input.birthId.replaceAll("-", "")}`);
		expect(first.roomId).toBeString();
		expect(first.url).toBe(`/?onboarding=${first.roomId}`);
		expect(app.fleet.introductions.get(first.roomId)).toMatchObject({
			kind: "persona",
			status: "active",
			agentId: first.agentId,
			data: { profile: { role: preset?.role, name: preset?.name } },
		});
		expect(app.fleet.onboarding.user().confirmed).toBeNull();
		expect(app.fleet.onboarding.user().sharedAgentIds).not.toContain(
			first.agentId,
		);
		expect(app.fleet.opened(first.agentId)).toBeUndefined();
		expect(await (await create(input)).json()).toEqual(first);
		expect(app.fleet.agents.list()).toHaveLength(3);
		expect(app.fleet.agents.get("kai")).toEqual(original);
		expect(app.fleet.presets.find((p) => p.id === "kai")).toEqual(preset);
		await app.stop();
		app = await startCodexFleet(options);
		expect(await (await create(input)).json()).toEqual(first);
		expect((await create({ ...input, templateId: "sion" })).status).toBe(409);
		expect(app.fleet.agents.list()).toHaveLength(3);
	} finally {
		await app.stop();
		rmSync(root, { recursive: true, force: true });
	}
});

test("template birth rejects mixed, missing and unknown template fields before creating agents", async () => {
	const root = mkdtempSync(join(tmpdir(), "lina-template-invalid-"));
	const app = await startCodexFleet({
		workspace: resolve(import.meta.dir, "../../.."),
		stateRoot: root,
		port: 0,
		env: {},
		homeDir: root,
	});
	try {
		const valid = {
			birthId: crypto.randomUUID(),
			templateId: "kai",
			mode: "fast",
		};
		for (const input of [
			{ ...valid, templateId: "lina" },
			{ ...valid, templateId: "unknown" },
			{ ...valid, presetId: null },
			{ ...valid, draftId: crypto.randomUUID() },
			{ ...valid, templateId: 22 },
			{ templateId: "kai", mode: "fast" },
		]) {
			const r = await fetch(
				`http://127.0.0.1:${app.port}/api/agents/birth`,
				body(input),
			);
			expect(r.status).toBe(400);
		}
		expect(app.fleet.agents.list()).toHaveLength(1);
	} finally {
		await app.stop();
		rmSync(root, { recursive: true, force: true });
	}
});
