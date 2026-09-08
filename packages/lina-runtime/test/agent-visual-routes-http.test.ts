import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { visualReferenceId } from "../src/fleet/agent-visual-routes.ts";
import { AgentFleet } from "../src/fleet/manager.ts";
import { startFleetServer } from "../src/fleet/server.ts";
import { png } from "./ima2-client-fixture.ts";

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => {
	for (const close of cleanup.splice(0).reverse()) await close();
});

async function fixture() {
	const root = mkdtempSync(join(tmpdir(), "lina-visual-http-"));
	cleanup.push(() => rmSync(root, { recursive: true, force: true }));
	const fleet = new AgentFleet({
		workspace: process.cwd(),
		stateRoot: root,
		agentDir: join(root, "auth"),
		systemPrompt: "test",
		createApp: async () => {
			throw Error("visual HTTP must not open a conversation");
		},
	});
	const server = await startFleetServer(fleet, 0, process.cwd(), "lina", {
		lazy: true,
	});
	cleanup.push(() => server.stop());
	const base = `http://127.0.0.1:${server.port}`;
	return { root, base, fleet };
}

test("visual HTTP rejects malformed owner fields and rejected references leave no bytes", async () => {
	const f = await fixture();
	const post = (path: string, value: unknown) =>
		fetch(f.base + path, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(value),
		});
	expect(
		(
			await post("/api/agents/lina/visual/pin", {
				requestKey: { forged: true },
				expectedRevision: 1,
				pinned: "false",
			})
		).status,
	).toBe(400);
	expect(
		(
			await post("/api/agents/lina/visual/apply", {
				requestKey: "apply",
				candidateId: { forged: true },
				expectedProfileRevision: 1,
				expectedVisualRevision: 1,
			})
		).status,
	).toBe(400);
	expect(
		(
			await fetch(`${f.base}/api/agents/lina/visual/references`, {
				method: "POST",
				headers: {
					"X-Lina-Filename": "reference.png",
					"X-Lina-Profile-Revision": "1",
					"X-Lina-Visual-Revision": "1",
				},
				body: png,
			})
		).status,
	).toBe(400);
	expect(existsSync(join(f.root, "visual-references"))).toBe(false);
});

test("visual reference upload requires a request key before any filesystem write", async () => {
	const f = await fixture();
	const visual = {
		anchors: [],
		canonicalReferenceId: null,
		textIdentity: null,
		avatarPolicy: null,
		referenceLimits: { maxAssets: 1, maxTotalBytes: png.length },
		maxHistoryRecords: 10,
	};
	f.fleet.agents.updateVisual("lina", 1, visual);
	expect(
		(
			await fetch(`${f.base}/api/agents/lina/visual/references`, {
				method: "POST",
				headers: {
					"X-Lina-Filename": "reference.png",
					"X-Lina-Profile-Revision": "1",
					"X-Lina-Visual-Revision": "2",
				},
				body: png,
			})
		).status,
	).toBe(400);
	expect(existsSync(join(f.root, "visual-references"))).toBe(false);
});

test("visual HTTP publishes an approved reference only after validation", async () => {
	const f = await fixture();
	const visual = {
		anchors: [],
		canonicalReferenceId: null,
		textIdentity: null,
		avatarPolicy: null,
		referenceLimits: { maxAssets: 1, maxTotalBytes: png.length },
		maxHistoryRecords: 10,
	};
	expect(
		(
			await fetch(`${f.base}/api/agents/lina/visual`, {
				method: "PUT",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ expectedRevision: 1, visual }),
			})
		).status,
	).toBe(200);
	const upload = () =>
		fetch(`${f.base}/api/agents/lina/visual/references`, {
			method: "POST",
			headers: {
				"X-Lina-Filename": "reference.png",
				"X-Lina-Profile-Revision": "1",
				"X-Lina-Visual-Revision": "2",
				"X-Lina-Request-Key": "concurrent-key",
			},
			body: png,
		});
	const responses = await Promise.all([upload(), upload()]);
	expect(responses.map((response) => response.status).sort()).toEqual([
		200, 201,
	]);
	const entries = readdirSync(join(f.root, "visual-references", "lina"));
	expect(entries).toHaveLength(1);
	expect(entries[0]).not.toContain(".tmp");
});

test("a charged reference with missing bytes is repaired only by its matching request key", async () => {
	const f = await fixture();
	const visual = {
		anchors: [],
		canonicalReferenceId: null,
		textIdentity: null,
		avatarPolicy: null,
		referenceLimits: { maxAssets: 1, maxTotalBytes: png.length },
		maxHistoryRecords: 10,
	};
	f.fleet.agents.updateVisual("lina", 1, visual);
	const assetId = visualReferenceId("lina", "repair-key");
	const asset = {
		sha256: "43739c566e26fd7cb88f69d3864ea34740372f5ee99acac169e090beffbce5c6",
		mime: "image/png" as const,
		size: png.length,
	};
	f.fleet.agents.registerVisualReference("lina", 1, 2, {
		version: 1,
		id: assetId,
		agentId: "lina",
		assetId,
		...asset,
		origin: { kind: "upload" },
	});
	expect(existsSync(join(f.root, "visual-references"))).toBe(false);
	const response = await fetch(`${f.base}/api/agents/lina/visual/references`, {
		method: "POST",
		headers: {
			"X-Lina-Filename": "reference.png",
			"X-Lina-Profile-Revision": "1",
			"X-Lina-Visual-Revision": "999",
			"X-Lina-Request-Key": "repair-key",
		},
		body: png,
	});
	expect(response.status).toBe(200);
	expect(readdirSync(join(f.root, "visual-references", "lina"))).toHaveLength(
		1,
	);
});
