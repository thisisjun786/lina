import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentStore } from "../../lina-core/src/agents/store.ts";
import { worldDefinition } from "../../lina-core/test/world-fixture.ts";
import { FleetLifeInstallation } from "../src/fleet/life-runtime-installation.ts";
import { FleetLifeForeground } from "../src/fleet/life-runtime-state.ts";
import { ModelSettingsStore } from "../src/models/settings.ts";

test("publication storage reads share the installation store without starting its runtime and recheck ownership on every access", async () => {
	const root = mkdtempSync(join(tmpdir(), "lina-publication-storage-"));
	const agents = new AgentStore(join(root, "agents.sqlite")),
		modelSettings = new ModelSettingsStore(join(root, "models.sqlite"));
	let owns = true,
		runtimeCalls = 0;
	const installation = new FleetLifeInstallation({
		root,
		agents,
		modelSettings,
		foreground: new FleetLifeForeground(),
		ownsInstallation: () => owns,
		assertAuthoring: () => {
			if (!owns) throw Error("Installation ownership lost");
		},
		authoring: async () => {
			throw Error("Read must never call a model");
		},
		createRuntime: () => {
			runtimeCalls++;
			throw Error("Runtime construction observed");
		},
	});
	try {
		const store = installation.storage;
		store.create(worldDefinition());
		expect(installation.storage).toBe(store);
		expect(installation.storage.snapshot("test-world").revision).toBe(0);
		expect(runtimeCalls).toBe(0);
		owns = false;
		expect(() => installation.storage).toThrow("Installation ownership lost");
		expect(runtimeCalls).toBe(0);
		owns = true;
		expect(() => installation.runtime).toThrow("Runtime construction observed");
		expect(runtimeCalls).toBe(1);
		expect(installation.storage).toBe(store);
	} finally {
		await installation.closeAuthoring();
		installation.closeStore();
		agents.close();
		modelSettings.close();
		rmSync(root, { recursive: true, force: true });
	}
});
