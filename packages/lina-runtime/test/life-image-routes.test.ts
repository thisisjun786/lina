import { afterEach, expect, mock, test } from "bun:test";
import { imageStoreFixture } from "../../lina-core/test/life-image-store-fixture.ts";
import { lifeImageRoutes } from "../src/fleet/life-image-routes.ts";

const cleanups: Array<() => void> = [];
afterEach(() => {
	for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

function fixture() {
	const f = imageStoreFixture();
	cleanups.push(() => f.close());
	const images = {
		run: mock(async () => ({ id: "job", state: "prepared" })),
		retry: mock(async () => ({ id: "job", state: "prepared" })),
		reconcile: mock(async () => ({ id: "job", state: "prepared" })),
		read: mock(() => ({ id: "job", state: "completed", artifact: null })),
		destinations: { avatar: mock(() => ({ status: "candidate" })) },
		posts: { attach: mock(() => ({ status: "held" })) },
	};
	const services = {
		store: mock(() => f.store),
		agents: {} as never,
		images: mock(() => images),
		now: () => 1000,
		changed: mock(() => {}),
		assertSourceCurrent: mock(() => {}),
	};
	return { f, images, services };
}

function request(
	path: string,
	method = "GET",
	body?: unknown,
	headers: Record<string, string> = {},
) {
	return new Request(`http://127.0.0.1${path}`, {
		method,
		headers: {
			host: "127.0.0.1",
			...(body === undefined ? {} : { "content-type": "application/json" }),
			...headers,
		},
		...(body === undefined ? {} : { body: JSON.stringify(body) }),
	});
}

const json = (request: Request) => async () => {
	const value: unknown = await request.json();
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw Error("expected object");
	return value as Record<string, unknown>;
};

test("cold image management GETs use only WorldStore and reject browser credentials", async () => {
	const { services } = fixture();
	const response = await lifeImageRoutes(
		request("/api/life/worlds/test-world/images/intents"),
		services as never,
		async () => ({}),
	);
	expect(response?.status).toBe(200);
	expect(services.images).not.toHaveBeenCalled();

	const hostile = await lifeImageRoutes(
		request("/api/life/worlds/test-world/images/settings", "GET", undefined, {
			origin: "http://evil.invalid",
		}),
		services as never,
		async () => ({}),
	);
	expect(hostile?.status).toBe(403);
	const hostileHost = await lifeImageRoutes(
		new Request("http://localhost/api/life/worlds/test-world/images/settings", {
			headers: { host: "localhost" },
		}),
		services as never,
		async () => ({}),
	);
	expect(hostileHost?.status).toBe(403);
	const bearer = await lifeImageRoutes(
		request("/api/life/worlds/test-world/images/settings", "GET", undefined, {
			authorization:
				"Bearer llv1_abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNO1234567890",
		}),
		services as never,
		async () => ({}),
	);
	expect(bearer?.status).toBe(403);
	const unbounded = await lifeImageRoutes(
		request("/api/life/worlds/test-world/images/intents?limit=101"),
		services as never,
		async () => ({}),
	);
	expect(unbounded?.status).toBe(400);
	expect(services.images).not.toHaveBeenCalled();
});

test("image management rejects malformed input and stale settings CAS before execution", async () => {
	const { services } = fixture();
	const malformedRequest = request(
		"/api/life/worlds/test-world/images/intents",
		"POST",
		{
			requestKey: "manual",
			expectedSettingsRevision: 1,
			agentId: "lina",
			source: { kind: "avatar_periodic" },
			prompt: "hostile",
		},
	);
	const malformed = await lifeImageRoutes(
		malformedRequest,
		services as never,
		json(malformedRequest),
	);
	expect(malformed?.status).toBe(400);

	const staleRequest = request(
		"/api/life/worlds/test-world/images/intents",
		"POST",
		{
			requestKey: "manual",
			expectedSettingsRevision: 99,
			agentId: "lina",
			source: { kind: "avatar_periodic" },
		},
	);
	const stale = await lifeImageRoutes(
		staleRequest,
		services as never,
		json(staleRequest),
	);
	expect(stale?.status).toBe(409);
	expect(services.images).not.toHaveBeenCalled();
});

test("run passes only stable request key and intent to the image owner", async () => {
	const { images, services } = fixture();
	images.run.mockResolvedValue({
		id: "job",
		origin: { kind: "life", attemptId: "attempt" },
		reference: { prompt: "private" },
	} as never);
	const intent = {
		intentId: "life-image-intent",
		owner: { kind: "life", worldId: "test-world", agentId: "lina" },
		source: {
			kind: "avatar_wall",
			scheduleKey: "schedule",
			slotIndex: 0,
			dueAtMs: 1000,
			resolvedPolicyId: "policy",
		},
		settingsRevision: 1,
		configRevision: 1,
		createdAtMs: 1000,
		createdLifeRevision: 1,
		requestKey: "original-key",
	};
	services.store.mockImplementation(
		() =>
			({
				imageIntent: () => intent,
				imageAttempts: () => [{ revision: 2 }],
				imageAttemptRequest: () => ({ intentId: intent.intentId }),
				imageAttempt: () => ({
					attemptId: "attempt",
					intentId: intent.intentId,
					attemptNumber: 1,
					revision: 2,
					previousAttemptId: null,
					observation: { state: "completed" },
					delivery: { kind: "pending" },
				}),
			}) as never,
	);
	const runRequest = request(
		`/api/life/worlds/test-world/images/intents/${intent.intentId}/run`,
		"POST",
		{ requestKey: "original-key", expectedRevision: 0 },
	);
	const response = await lifeImageRoutes(
		runRequest,
		services as never,
		json(runRequest),
	);
	expect(response?.status).toBe(200);
	expect(images.run).toHaveBeenCalledWith(
		"test-world",
		intent.intentId,
		"original-key",
		expect.any(AbortSignal),
	);
	expect(services.changed).toHaveBeenCalledTimes(1);
	const body = await response?.json();
	expect(body).toEqual({
		attempt: {
			attemptId: "attempt",
			intentId: intent.intentId,
			attemptNumber: 1,
			revision: 2,
			previousAttemptId: null,
			state: "completed",
			delivery: "pending",
		},
	});
});

test("intent creation replays its recorded prepare request before current settings CAS", async () => {
	const { services } = fixture();
	const intent = {
		intentId: "life-image-intent",
		owner: { kind: "life", worldId: "test-world", agentId: "lina" },
		source: {
			kind: "avatar_wall",
			scheduleKey: "schedule",
			slotIndex: 0,
			dueAtMs: 1000,
			resolvedPolicyId: "policy",
		},
		settingsRevision: 1,
		configRevision: 1,
		createdAtMs: 1000,
		createdLifeRevision: 1,
		requestKey: "create-key",
	};
	services.store.mockImplementation(
		() =>
			({
				imageIntents: () => [intent],
			}) as never,
	);
	const replay = request("/api/life/worlds/test-world/images/intents", "POST", {
		requestKey: "create-key",
		expectedSettingsRevision: 99,
		agentId: "lina",
		source: { kind: "avatar_periodic" },
	});
	const response = await lifeImageRoutes(
		replay,
		services as never,
		json(replay),
	);
	expect(response?.status).toBe(200);
	expect(services.changed).not.toHaveBeenCalled();
});

test("event apply accepts null avatar input and returns no destination receipt", async () => {
	const { images, services } = fixture();
	const intent = {
		intentId: "event-intent",
		owner: { kind: "life", worldId: "test-world", agentId: "lina" },
		source: {
			kind: "event_post",
			publicationId: "post",
			recipientId: "friends",
		},
	};
	const attempt = {
		attemptId: "attempt",
		intentId: intent.intentId,
		attemptNumber: 1,
		revision: 1,
		previousAttemptId: null,
		observation: { state: "completed" },
		delivery: { kind: "pending" },
	};
	images.read.mockReturnValue({
		id: "job",
		origin: { kind: "life", attemptId: "attempt" },
	} as never);
	services.store.mockImplementation(
		() => ({ imageIntent: () => intent, imageAttempt: () => attempt }) as never,
	);
	const apply = request(
		`/api/life/worlds/test-world/images/intents/${intent.intentId}/apply`,
		"POST",
		{ expectedRevision: 1, attemptId: "attempt", avatarApply: null },
	);
	const response = await lifeImageRoutes(apply, services as never, json(apply));
	expect(response?.status).toBe(200);
	expect(images.posts.attach).toHaveBeenCalledWith(
		expect.any(Object),
		"manual",
	);
	expect(await response?.json()).toEqual({
		attempt: expect.objectContaining({ attemptId: "attempt" }),
	});
});
