import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
	WorldDraft,
	WorldDraftPreview,
} from "../../lina-core/src/world/authoring-types.ts";
import { AgentFleet } from "../src/fleet/manager.ts";
import { startFleetServer } from "../src/fleet/server.ts";
import {
	authorPack,
	authorPreview,
	emptyLifeConfig,
} from "./life-authoring-fixture.ts";

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => {
	for (const close of cleanup.splice(0).reverse()) await close();
});
async function fixture() {
	const root = mkdtempSync(join(tmpdir(), "lina-author-http-"));
	cleanup.push(() => rmSync(root, { recursive: true, force: true }));
	let calls = 0;
	const fleet = new AgentFleet({
		workspace: process.cwd(),
		stateRoot: root,
		agentDir: join(root, "auth"),
		systemPrompt: "unused",
		ownsInstallation: () => true,
		createApp: async () => {
			throw Error("Ordinary conversation must not open");
		},
		modelControl: {
			catalog: () => [],
			state: () => ({
				provider: "synthetic",
				model: "author",
				settingsRevision: 0,
				error: null,
			}),
			test: async () => {
				throw Error("Unexpected model test");
			},
			authoring: async () => {
				calls++;
				return {
					provider: "synthetic",
					model: "author",
					text: JSON.stringify(authorPack()),
				};
			},
		},
	});
	const server = await startFleetServer(fleet, 0, process.cwd(), "lina", {
		lazy: true,
	});
	cleanup.push(() => server.stop());
	const base = `http://127.0.0.1:${server.port}`;
	const send = (
		path: string,
		method = "GET",
		body?: unknown,
		headers?: Record<string, string>,
	) =>
		fetch(`${base}/api/life${path}`, {
			method,
			headers: {
				...(body === undefined ? {} : { "content-type": "application/json" }),
				...headers,
			},
			...(body === undefined ? {} : { body: JSON.stringify(body) }),
		});
	return { fleet, base, send, calls: () => calls };
}

test("real fleet HTTP draft/edit/preview/confirmation/config path preserves exact revisions and null omissions", async () => {
	const f = await fixture();
	const created = await f.send("/drafts", "POST", {
		worldId: "test-world",
		authoredText: "An island in an unspecified era",
	});
	expect(created.status).toBe(201);
	const draft = (await created.json()) as WorldDraft;
	const changed = await f.send(`/drafts/${draft.id}`, "PATCH", {
		expectedRevision: draft.revision,
		patch: { authoredText: draft.authoredText, pack: authorPack() },
	});
	expect(changed.status).toBe(200);
	const edited = (await changed.json()) as WorldDraft;
	const previewResponse = await f.send(`/drafts/${draft.id}/preview`, "POST", {
		expectedRevision: edited.revision,
		options: authorPreview,
	});
	expect(previewResponse.status).toBe(200);
	const preview = (await previewResponse.json()) as WorldDraftPreview;
	expect(preview.canActivate).toBe(true);
	const confirmation = {
		draftId: draft.id,
		expectedRevision: edited.revision,
		idempotencyKey: "confirm-1",
		packDigest: preview.packDigest,
		previewDigest: preview.digest,
		options: authorPreview,
	};
	expect(
		(
			await f.send(`/drafts/${draft.id}/confirm`, "POST", {
				...confirmation,
				expectedRevision: edited.revision + 1,
			})
		).status,
	).toBe(409);
	expect(
		(await f.send(`/drafts/${draft.id}/confirm`, "POST", confirmation)).status,
	).toBe(200);
	const updated = await f.send("/worlds/test-world/config", "PUT", {
		expectedRevision: 0,
		config: emptyLifeConfig,
	});
	expect(updated.status).toBe(200);
	expect(await updated.json()).toMatchObject({
		config: { clock: null, run: null, models: null },
		readiness: { status: "not_configured", automaticReady: false },
	});
	expect((await f.send("/worlds/test-world/pack?version=1")).status).toBe(200);
	expect(
		(
			await f.send("/worlds/test-world/config", "PUT", {
				expectedRevision: 0,
				config: emptyLifeConfig,
			})
		).status,
	).toBe(409);
	expect(
		(
			await f.send("/worlds/test-world/config", "PUT", {
				expectedRevision: 1,
				config: { ...emptyLifeConfig, run: { mode: "immediate" } },
			})
		).status,
	).toBe(400);
	expect(
		(
			await f.send(`/drafts/${draft.id}/confirm`, "POST", {
				...confirmation,
				extra: "authority",
			})
		).status,
	).toBe(400);
	expect(f.calls()).toBe(0);
	expect(f.fleet.opened("lina")).toBeUndefined();
});

test("life routes reject hostile origin, host, method, query and unknown/oversized bodies", async () => {
	const f = await fixture();
	expect(
		(await f.send("/drafts", "GET", undefined, { origin: "https://evil.test" }))
			.status,
	).toBe(403);
	expect(
		(await f.send("/drafts", "GET", undefined, { host: "evil.test" })).status,
	).toBe(403);
	expect((await f.send("/drafts", "DELETE")).status).toBe(405);
	expect((await f.send("/drafts?limit=1&limit=2")).status).toBe(400);
	expect((await f.send("/drafts?extra=1")).status).toBe(400);
	expect(
		(
			await f.send("/drafts", "POST", {
				worldId: "test-world",
				authoredText: "text",
				grantId: "spoofed",
			})
		).status,
	).toBe(400);
	expect(
		(
			await f.send("/drafts", "POST", {
				worldId: "test-world",
				authoredText: "a".repeat(70000),
			})
		).status,
	).toBe(400);
	expect(f.calls()).toBe(0);
});

test("unknown guides and grant-injection fields cannot open an ordinary conversation", async () => {
	const f = await fixture();
	const created = await f.send("/drafts", "POST", {
		worldId: "test-world",
		authoredText: "Only an era and environment",
	});
	expect(created.status).toBe(201);
	expect(
		(
			await f.send("/author-sessions", "POST", {
				worldId: "test-world",
				agentId: "missing",
			})
		).status,
	).toBe(400);
	expect(
		(
			await f.send("/author-sessions", "POST", {
				worldId: "test-world",
				agentId: "lina",
				ready: true,
			})
		).status,
	).toBe(400);
	expect(
		(
			await f.send("/author-sessions", "POST", {
				worldId: "test-world",
				agentId: "lina",
			})
		).status,
	).toBe(503);
	expect(f.fleet.opened("lina")).toBeUndefined();
	expect(f.calls()).toBe(0);
});
