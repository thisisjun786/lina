import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listedModelIds } from "../../packages/lina-codex/src/model.ts";
import { createCodexRpc } from "../../packages/lina-codex/src/rpc.ts";
import {
	deriveNativeCatalog,
	parseHubModels,
} from "../../packages/lina-opencodex/src/catalog.ts";
import { OpenCodexHub } from "../../packages/lina-opencodex/src/hub.ts";
import { provisionCodexHome } from "../../packages/lina-runtime/src/fleet/codex-home.ts";

const root = mkdtempSync(join(tmpdir(), "lina-derived-catalog-"));
const hub = new OpenCodexHub();
await hub.refresh();
const connection = hub.isolatedHomeConnection();
assert.ok(connection);
// Capture the advertised public metadata from the configured local Hub, no credentials printed.
const response = await fetch("http://127.0.0.1:10100/v1/models");
assert.equal(response.status, 200);
const models = parseHubModels(await response.json());
const catalogJson = deriveNativeCatalog(models);
const home = provisionCodexHome(root, { ...connection, catalogJson });
const rpc = await createCodexRpc({
	cwd: root,
	env: { ...hub.childEnvironment(), CODEX_HOME: home },
});
const records: unknown[] = [];
try {
	await rpc.request("initialize", {
		clientInfo: { name: "lina-derived-catalog-probe", version: "1.0" },
		capabilities: { experimentalApi: true },
	});
	rpc.notify("initialized");
	const listed = listedModelIds(await rpc.request("model/list", {}));
	const expected = models
		.filter((m) => m.endpoint === "responses")
		.map((m) => m.id);
	const missing = expected.filter((id) => !listed.includes(id));
	records.push({
		catalogSource: "derived-models",
		expected,
		listed,
		missing,
		modelCalls: 0,
	});
	assert.deepEqual(missing, []);
	const model = "cursor/composer-2.5-fast";
	const started = await rpc.request<{ thread: { id: string } }>(
		"thread/start",
		{
			cwd: root,
			model,
			modelProvider: "opencodex",
			sandbox: "read-only",
			approvalPolicy: "on-request",
			baseInstructions:
				"Synthetic compatibility check only. No tools. Reply with the marker requested by the user.",
		},
	);
	let timer: ReturnType<typeof setTimeout> | undefined;
	const done = new Promise<void>((resolve, reject) => {
		timer = setTimeout(
			() => reject(Error("derived model turn timeout")),
			60000,
		);
		rpc.subscribe((method, params) => {
			if (
				method === "turn/completed" &&
				(params as { threadId?: string })?.threadId === started.thread.id
			) {
				clearTimeout(timer);
				resolve();
			}
		});
	});
	try {
		await rpc.request("turn/start", {
			threadId: started.thread.id,
			model,
			input: [
				{
					type: "text",
					text: "Reply exactly LINA_DERIVED_MODEL_OK. No tools.",
					text_elements: [],
				},
			],
		});
		await done;
		const result = await rpc.request<{ thread: unknown }>("thread/read", {
			threadId: started.thread.id,
			includeTurns: true,
		});
		assert.ok(JSON.stringify(result.thread).includes("LINA_DERIVED_MODEL_OK"));
		records.push({ model, modelCalls: 1, nativeHarnessResponse: true });
	} finally {
		clearTimeout(timer);
	}
} catch (error) {
	records.push({
		error: error instanceof Error ? error.message : String(error),
	});
	process.exitCode = 1;
} finally {
	await rpc.close();
	rmSync(root, { recursive: true, force: true });
	records.push({ ownedProcessClosed: true, tempRootRemoved: true });
	await Bun.write(
		new URL(
			"../../devlog/_plan/260906_codex_runtime/097_derived_catalog.json",
			import.meta.url,
		),
		JSON.stringify(records, null, 2) + "\n",
	);
	console.log(JSON.stringify(records));
}
