import { expect, test } from "bun:test";
import { InactiveMemory } from "../src/context/memory.ts";

test("legacy external memory is migration-required and cannot return unsupported recall", async () => {
	const memory = new InactiveMemory("migration_required");
	expect(memory.status()).toMatchObject({
		service: "unavailable",
		migrationRequired: true,
		pending: 0,
	});
	await memory.refresh();
	expect(await memory.recall("past context")).toBe("");
	expect(memory.recallSourceProofs("claim")).toBeUndefined();
	await memory.close();
});

test("Fleet preserves the legacy backend decision without invoking remote initialization", async () => {
	const { AgentFleet } = await import("../src/fleet/manager.ts"),
		{ mkdtempSync, rmSync } = await import("node:fs"),
		{ tmpdir } = await import("node:os"),
		{ join } = await import("node:path");
	const root = mkdtempSync(join(tmpdir(), "lina-legacy-fleet-"));
	let calls = 0;
	const fleet = new AgentFleet({
		workspace: process.cwd(),
		stateRoot: root,
		agentDir: join(root, "auth"),
		systemPrompt: "test",
		memoryBackend: "honcho",
		createApp: async () => {
			calls++;
			throw Error("should remain lazy");
		},
	});
	try {
		expect(
			await fleet.initializeMemory("lina", new AbortController().signal),
		).toBe(false);
		expect(calls).toBe(0);
		expect(fleet.summary()[0]?.memory).toBe("unavailable");
	} finally {
		await fleet.close();
		rmSync(root, { recursive: true, force: true });
	}
});
