import { afterEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodexHost } from "../../lina-codex/src/host.ts";
import {
	ApprovalGate,
	ControlStore,
} from "../../lina-core/src/control/index.ts";
import { WorldStore } from "../../lina-core/src/world/store.ts";
import { ExecutionCoordinator } from "../src/execution.ts";
import { installExecutionHooks } from "../src/execution-hooks.ts";
import { WorldAuthoring } from "../src/life/authoring.ts";
import { createWorldAuthorTools } from "../src/life/tools.ts";
import { authorPack, authorPreview } from "./life-authoring-fixture.ts";

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => {
	for (const close of cleanup.splice(0).reverse()) await close();
});

function fixture() {
	const root = mkdtempSync(join(tmpdir(), "lina-author-discovery-"));
	cleanup.push(() => rmSync(root, { recursive: true, force: true }));
	const store = new WorldStore(join(root, "world.sqlite"));
	cleanup.push(() => store.close());
	let modelSettingsRevision = 7;
	const service = new WorldAuthoring({
		store,
		agentExists: (id) => id === "lina",
		modelSettingsRevision: () => modelSettingsRevision,
		authoring: async () => {
			throw Error("No provider spend");
		},
	});
	cleanup.push(() => service.close());
	const drafts = [0, 1, 2].map((index) =>
		service.create({
			worldId: "test-world",
			authoredText: `Private draft ${index}`,
		}),
	);
	const foreign = service.create({
		worldId: "foreign-world",
		authoredText: "FOREIGN SECRET",
	});
	const grant = store.grantWorldAuthor("test-world", "lina");
	const controls = new ControlStore(join(root, "control.sqlite"), {
		version: 1,
		botId: "lina",
		sessionId: "author-discovery",
		sessionFile: join(root, "session.jsonl"),
		workspace: root,
	});
	cleanup.push(() => controls.close());
	const execution = new ExecutionCoordinator({
		approvalMode: "confirm",
		store: controls,
		gate: new ApprovalGate(controls),
		requestId: () => "discover",
		runtimeState: () => ({ cancelling: false, cancelRequestId: null }),
	});
	cleanup.push(() => execution.close());
	const host = new CodexHost(root, () => ({ action: "allow" }));
	installExecutionHooks(host, execution);
	for (const tool of createWorldAuthorTools(service, grant))
		host.registerTool(tool);
	const invoke = (input: unknown) =>
		host.invokeTool(
			"lina_world_draft_read",
			randomUUID(),
			input,
			new AbortController().signal,
		);
	const read = async (input: unknown) => {
		const reply = await invoke(input);
		expect(reply.success).toBe(true);
		expect(execution.snapshot().approvals).toHaveLength(0);
		return JSON.parse(reply.contentItems.map((item) => item.text).join(""));
	};
	return {
		store,
		service,
		grant,
		drafts,
		foreign,
		read,
		invoke,
		changeModel() {
			modelSettingsRevision++;
		},
	};
}

test("author read discovers bounded own draft IDs and current settings without an injected opaque ID", async () => {
	const f = fixture();
	const first = await f.read({ query: "overview", limit: 2 });
	expect(first).toMatchObject({
		worldId: "test-world",
		agentId: "lina",
		modelSettingsRevision: 7,
		currentWorld: null,
	});
	expect(first.drafts.items).toHaveLength(2);
	expect(JSON.stringify(first)).not.toContain(f.foreign.id);
	expect(JSON.stringify(first)).not.toContain("FOREIGN SECRET");
	const second = await f.read({
		query: "overview",
		afterId: first.drafts.nextCursor,
		limit: 2,
	});
	expect(second.drafts.items).toHaveLength(1);
	expect(second.drafts.nextCursor).toBeNull();
	const ids = [...first.drafts.items, ...second.drafts.items]
		.map((item) => item.id)
		.sort();
	expect(ids).toEqual(f.drafts.map((item) => item.id).sort());
	expect(await f.read({ draftId: ids[0] })).toMatchObject({
		id: ids[0],
		worldId: "test-world",
	});
	f.changeModel();
	expect(await f.read({ query: "overview" })).toMatchObject({
		modelSettingsRevision: 8,
	});
});

test("author read inspects current and historical confirmed packs through the same automatic read gate", async () => {
	const f = fixture();
	for (const version of [1, 2]) {
		const pack = authorPack();
		pack.version = version;
		pack.world.version = version;
		pack.life.revision = version;
		pack.world.title = `Confirmed version ${version}`;
		const raw = f.service.create({
			worldId: pack.worldId,
			authoredText: pack.background.authoredText,
		});
		const draft = f.service.edit(raw.id, raw.revision, {
			authoredText: raw.authoredText,
			pack,
		});
		const options = {
			...authorPreview,
			expectedWorldRevision: version === 1 ? null : 0,
		};
		const preview = f.service.preview(draft.id, draft.revision, options);
		expect(preview.canActivate).toBe(true);
		f.service.confirm({
			draftId: draft.id,
			expectedRevision: draft.revision,
			packDigest: preview.packDigest,
			previewDigest: preview.digest,
			idempotencyKey: `confirm-${version}`,
			options,
		});
	}
	expect(await f.read({ query: "overview" })).toMatchObject({
		currentWorld: { worldId: "test-world", packVersion: 2 },
	});
	expect(await f.read({ query: "pack" })).toMatchObject({
		worldId: "test-world",
		version: 2,
		world: { title: "Confirmed version 2" },
	});
	expect(await f.read({ query: "pack", version: 1 })).toMatchObject({
		worldId: "test-world",
		version: 1,
		world: { title: "Confirmed version 1" },
	});
});

test("author discovery refuses query mixtures, authority overrides, excess bounds and revoked access", async () => {
	const f = fixture();
	for (const input of [
		{},
		{ query: "overview", worldId: "foreign-world" },
		{ query: "overview", agentId: "foreign" },
		{ query: "overview", limit: 33 },
		{ query: "overview", limit: 0 },
		{ query: "overview", version: 1 },
		{ query: "pack", draftId: f.foreign.id },
		{ query: "pack", version: 0 },
		{ query: "pack", worldId: "foreign-world" },
		{ query: "unknown" },
	])
		await expect(f.invoke(input)).rejects.toThrow("Invalid tool arguments");
	expect((await f.invoke({ draftId: f.foreign.id })).success).toBe(false);
	f.store.revokeWorldAuthor(f.grant.id, f.grant.revision);
	for (const input of [
		{ query: "overview" },
		{ query: "pack" },
		{ draftId: f.drafts[0]?.id },
	])
		expect((await f.invoke(input)).success).toBe(false);
});
