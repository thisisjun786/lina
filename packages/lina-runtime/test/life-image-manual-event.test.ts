import { afterEach, expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentStore } from "../../lina-core/src/agents/store.ts";
import { visualIdentityDigest } from "../../lina-core/src/agents/visual-validation.ts";
import { publishedImageFixture } from "../../lina-core/test/life-image-publication-fixture.ts";
import { lifeImageRoutes } from "../src/fleet/life-image-routes.ts";

const cleanups: Array<() => void> = [];
afterEach(() => {
	for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

function request(path: string, method: string, body: unknown) {
	return new Request(`http://127.0.0.1${path}`, {
		method,
		headers: { host: "127.0.0.1", "content-type": "application/json" },
		body: JSON.stringify(body),
	});
}

const json = (value: Request) => async () => {
	const body: unknown = await value.json();
	if (!body || typeof body !== "object" || Array.isArray(body))
		throw Error("expected object");
	return body as Record<string, unknown>;
};

function fixture(options: { allowScene?: boolean; grant?: boolean } = {}) {
	const published = publishedImageFixture(
		false,
		"Residents met at the cafe.",
		options.allowScene === true,
	);
	const temp = mkdtempSync(join(tmpdir(), "lina-life-manual-event-"));
	const agents = new AgentStore(join(temp, "agents.sqlite"));
	agents.create({
		id: "lina",
		name: "Lina",
		role: "assistant",
		personality: "curious",
		voice: "warm",
		profile: "Private biography",
		appearance: "silver eyes",
		interests: [],
		avatarId: null,
		evolution: "adaptive",
	});
	const visual = agents.updateVisual("lina", 1, {
		anchors: ["blue hair"],
		textIdentity: "Approved identity",
		canonicalReferenceId: null,
		avatarPolicy: null,
		referenceLimits: { maxAssets: 3, maxTotalBytes: 100000 },
		maxHistoryRecords: 100,
	});
	if (options.grant !== false)
		agents.putVisualGrant("lina", visual.revision, {
			version: 1,
			id: "manual-event-grant",
			agentId: "lina",
			revision: 1,
			subject: {
				kind: "text_identity",
				identityDigest: visualIdentityDigest(visual),
			},
			providerUse: true,
			purposes: [
				{ kind: "life", worldId: "test-world", recipientId: "friends" },
			],
			revoked: false,
		});
	const config = published.store.lifeConfig("test-world");
	const {
		worldId: _worldId,
		revision: configRevision,
		...configInput
	} = config;
	published.store.setLifeConfig("test-world", configRevision, {
		...configInput,
		images: { mode: "manual", maxPerStep: 2 },
		usage: {
			windowMs: 1000,
			maxImages: 2,
			maxInputTokens: 100,
			maxOutputTokens: 100,
		},
	});
	const settings = published.store.setImageSettings("test-world", 0, {
		version: 1,
		worldVersion: null,
		route: { provider: "synthetic", model: "image" },
		eventRules: [],
		avatarEventRules: [],
		perAuthorCooldownSteps: 99,
		attachMode: "manual",
		maxJobsPerVisit: 1,
		storage: {
			maxActiveJobs: 4,
			maxArchivedJobs: 4,
			maxAssets: 4,
			maxTotalBytes: 1000000,
		},
	});
	const images = mock(() => {
		throw Error("management reads must never start the image owner");
	});
	const services = {
		store: mock(() => published.store),
		agents,
		images,
		now: () => 1000,
		changed: mock(() => {}),
		assertSourceCurrent: mock(() => {}),
	};
	const close = () => {
		agents.close();
		published.store.close();
		rmSync(temp, { recursive: true, force: true });
	};
	cleanups.push(close);
	return { ...published, agents, settings, images, services, close };
}

async function createIntent(
	f: ReturnType<typeof fixture>,
	body: Record<string, unknown>,
) {
	const req = request(
		"/api/life/worlds/test-world/images/intents",
		"POST",
		body,
	);
	return lifeImageRoutes(req, f.services, json(req));
}

test("explicit event image request succeeds without automatic event rules", async () => {
	const f = fixture({ allowScene: true });
	const material = f.store.publishedImageMaterial(
		"test-world",
		f.postId,
		"lina",
		"friends",
	);
	if (!material) throw Error("Missing permitted publication");
	expect(material.scene?.occupants).toContain("mira");
	expect(f.settings.eventRules).toEqual([]);

	const response = await createIntent(f, {
		requestKey: "manual-event",
		expectedSettingsRevision: f.settings.revision,
		agentId: "lina",
		source: {
			kind: "event_post",
			postId: f.postId,
			recipientId: "friends",
		},
	});
	expect(response?.status).toBe(201);
	const body = (await response?.json()) as {
		intent: {
			intentId: string;
			owner: unknown;
			source: unknown;
			requestKey: string;
		};
	};
	expect(body.intent.owner).toEqual({
		kind: "life",
		worldId: "test-world",
		agentId: "lina",
	});
	expect(body.intent.source).toEqual({
		kind: "event_post",
		postId: f.postId,
		recipientId: "friends",
	});
	expect(body.intent.requestKey).toBe("manual-event");
	expect(JSON.stringify(body)).not.toContain("prompt");
	expect(JSON.stringify(body)).not.toContain("secret dragon");
	expect(JSON.stringify(body)).not.toContain("Private biography");
	expect(f.images).not.toHaveBeenCalled();
	expect(f.services.changed).toHaveBeenCalledTimes(1);

	const stored = f.store.imageIntent("test-world", body.intent.intentId);
	expect(stored?.source).toEqual(material.source);
	expect(stored?.material.visuals.map((visual) => visual.agentId)).toEqual([
		"lina",
	]);
	expect(stored?.material.visuals[0]?.grants).toEqual([
		{
			grantId: "manual-event-grant",
			revision: 1,
			purpose: {
				kind: "life",
				worldId: "test-world",
				recipientId: "friends",
			},
		},
	]);
});

test("automatic cooldown and an existing post intent do not block an explicit request", async () => {
	const f = fixture();
	const material = f.store.publishedImageMaterial(
		"test-world",
		f.postId,
		"lina",
		"friends",
	);
	if (!material) throw Error("Missing permitted publication");
	const automatic = f.store.freezeImageIntent({
		worldId: "test-world",
		agentId: "lina",
		source: material.source,
		visuals: [
			f.agents.freezeVisualIdentity("lina", {
				kind: "life",
				worldId: "test-world",
				recipientId: "friends",
			}),
		],
		requestKey: null,
	});
	const response = await createIntent(f, {
		requestKey: "manual-after-automatic",
		expectedSettingsRevision: f.settings.revision,
		agentId: "lina",
		source: {
			kind: "event_post",
			postId: f.postId,
			recipientId: "friends",
		},
	});
	expect(response?.status).toBe(201);
	const body = (await response?.json()) as { intent: { intentId: string } };
	expect(body.intent.intentId).not.toBe(automatic.intentId);
	expect(f.store.imageIntents("test-world")).toHaveLength(2);
});

test("explicit event image requestKey replays the original selector and rejects a conflict", async () => {
	const f = fixture();
	const body = {
		requestKey: "manual-replay",
		expectedSettingsRevision: f.settings.revision,
		agentId: "lina",
		source: {
			kind: "event_post",
			postId: f.postId,
			recipientId: "friends",
		},
	};
	const created = await createIntent(f, body);
	expect(created?.status).toBe(201);
	const first = await created?.json();
	f.services.changed.mockClear();
	const replay = await createIntent(f, {
		...body,
		expectedSettingsRevision: 99,
	});
	expect(replay?.status).toBe(200);
	expect(await replay?.json()).toEqual(first);
	expect(f.services.changed).not.toHaveBeenCalled();
	const conflict = await createIntent(f, {
		...body,
		source: {
			kind: "event_post",
			postId: f.postId,
			recipientId: "public",
		},
	});
	expect(conflict?.status).toBe(409);
});

test("explicit event image request keeps visual grant and capability rejection", async () => {
	const missing = fixture({ grant: false });
	const denied = await createIntent(missing, {
		requestKey: "manual-denied",
		expectedSettingsRevision: missing.settings.revision,
		agentId: "lina",
		source: {
			kind: "event_post",
			postId: missing.postId,
			recipientId: "friends",
		},
	});
	expect(denied?.status).toBe(400);
	expect(missing.store.imageIntents("test-world")).toHaveLength(0);
	expect(missing.images).not.toHaveBeenCalled();
	const invented = await createIntent(missing, {
		requestKey: "manual-composition",
		expectedSettingsRevision: missing.settings.revision,
		agentId: "lina",
		source: {
			kind: "event_post",
			postId: missing.postId,
			recipientId: "friends",
		},
		composition: "all_scene_subjects",
	});
	expect(invented?.status).toBe(400);

	const f = fixture();
	const unavailable = await createIntent(f, {
		requestKey: "manual-wrong-audience",
		expectedSettingsRevision: f.settings.revision,
		agentId: "lina",
		source: {
			kind: "event_post",
			postId: f.postId,
			recipientId: "public",
		},
	});
	expect(unavailable?.status).toBe(404);
	const wrongAuthor = await createIntent(f, {
		requestKey: "manual-wrong-author",
		expectedSettingsRevision: f.settings.revision,
		agentId: "mira",
		source: {
			kind: "event_post",
			postId: f.postId,
			recipientId: "friends",
		},
	});
	expect(wrongAuthor?.status).toBe(404);
});

test("image management rejects non-JSON content types before parsing or changing state", async () => {
	const f = fixture();
	for (const contentType of [
		null,
		"text/plain",
		"application/x-www-form-urlencoded",
	]) {
		const req = request("/api/life/worlds/test-world/images/intents", "POST", {
			requestKey: "wrong-media-type",
			expectedSettingsRevision: f.settings.revision,
			agentId: "lina",
			source: { kind: "event_post", postId: f.postId, recipientId: "friends" },
		});
		if (contentType === null) req.headers.delete("content-type");
		else req.headers.set("content-type", contentType);
		const parse = mock(json(req));
		expect((await lifeImageRoutes(req, f.services, parse))?.status).toBe(400);
		expect(parse).not.toHaveBeenCalled();
	}
	expect(f.store.imageIntents("test-world")).toHaveLength(0);
	expect(f.services.changed).not.toHaveBeenCalled();
});
