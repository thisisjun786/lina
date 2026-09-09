import { expect, test } from "bun:test";
import { fleetMemoryFixture } from "./helpers/fleet-work-memory.ts";

test("legacy memory initialization reports migration without opening a session", async () => {
	const f = await fleetMemoryFixture({ memoryBackend: "honcho" });
	try {
		const response = await f.call("/api/agents/lina/memory", {});
		expect(response.status).toBe(409);
		expect(await response.json()).toMatchObject({
			code: "MEMORY_MIGRATION_REQUIRED",
			migrationRequired: true,
		});
		expect(f.received.size).toBe(0);
	} finally {
		await f.close();
	}
});
