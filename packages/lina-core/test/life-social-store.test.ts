import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { WorldSocialPort } from "../src/world/social-store-types.ts";
import { WorldStore } from "../src/world/store.ts";
import { socialIntent } from "./life-social-pack-fixture.ts";
import {
	activateSocialPack,
	socialRequest,
} from "./life-social-store-fixture.ts";

const roots: string[] = [],
	stores: WorldStore[] = [];
afterEach(() => {
	for (const store of stores.splice(0)) store.close();
	for (const root of roots.splice(0))
		rmSync(root, { recursive: true, force: true });
});
function open(path: string) {
	const store = new WorldStore(path);
	stores.push(store);
	return store as WorldStore & WorldSocialPort;
}
function setup() {
	const root = mkdtempSync(join(tmpdir(), "lina-social-store-"));
	roots.push(root);
	const path = join(root, "world.sqlite");
	return { path, store: activateSocialPack(open(path)) };
}

test("an unknown primitive produces a durable unchanged receipt without allocating entropy", () => {
	const { store, path } = setup();
	const before = store.lifeSnapshot("test-world");
	const request = socialRequest({
		intent: {
			...socialIntent(),
			primitives: [{ kind: "teleport", proposal: "An extension idea" }],
		},
	});
	const prepared = store.prepareSocialResolution(request, () => {
		throw Error("entropy must not be called");
	});
	expect(prepared.result).toMatchObject({
		kind: "unchanged",
		outcome: "extension_required",
		effects: [],
		checkpoint: before.checkpoint,
	});
	expect(store.lifeSnapshot("test-world")).toEqual(before);
	expect(() =>
		store.acceptSocialResolution("test-world", "request-1", request.identity),
	).toThrow();
	store.close();
	const restarted = open(path);
	expect(
		restarted.prepareSocialResolution(request, () => {
			throw Error("retry entropy");
		}),
	).toEqual(prepared);
	const raw = new DatabaseSync(path);
	try {
		expect(raw.prepare("SELECT * FROM world_social_bootstraps").all()).toEqual(
			[],
		);
	} finally {
		raw.close();
	}
});

test("prepared requests survive reopening and competing requests reuse the one world seed", () => {
	const { store, path } = setup();
	const request = socialRequest();
	let calls = 0;
	const prepared = store.prepareSocialResolution(request, () => {
		calls++;
		return 123456;
	});
	expect(prepared.input.bootstrap?.seed).toBe(123456);
	expect(calls).toBe(1);
	store.close();
	const restarted = open(path);
	expect(restarted.socialResolution("test-world", request.requestId)).toEqual(
		prepared,
	);
	expect(
		restarted.prepareSocialResolution(request, () => {
			throw Error("retry entropy");
		}),
	).toEqual(prepared);
	const peer = open(path);
	const second = peer.prepareSocialResolution(
		socialRequest({ requestId: "request-2" }),
		() => {
			throw Error("second seed");
		},
	);
	expect(second.input.bootstrap).toEqual(prepared.input.bootstrap);
	expect(peer.lifeSnapshot("test-world").revision).toBe(0);
	expect(() =>
		peer.prepareSocialResolution({ ...request, simulationTime: 2 }, () => 1),
	).toThrow(/conflict/i);
});

test("malformed known input cannot leave a bootstrap or request row", () => {
	const { store, path } = setup();
	expect(() =>
		store.prepareSocialResolution(
			socialRequest({
				intent: {
					...socialIntent(),
					primitives: [
						{
							kind: "transfer",
							predicateId: "coins",
							toAgentId: "mira",
							amount: -1,
						},
					],
				},
			}),
			() => 123,
		),
	).toThrow();
	const raw = new DatabaseSync(path);
	try {
		expect(raw.prepare("SELECT * FROM world_social_bootstraps").all()).toEqual(
			[],
		);
		expect(raw.prepare("SELECT * FROM world_social_resolutions").all()).toEqual(
			[],
		);
	} finally {
		raw.close();
	}
});

test("insufficient history or byte capacity fails before entropy and request preparation", () => {
	const { store, path } = setup();
	const request = socialRequest();
	for (const limits of [
		{ ...request.limits, maxHistoryEntries: 17 },
		{ ...request.limits, maxBytes: 256 },
	]) {
		expect(() =>
			store.prepareSocialResolution({ ...request, limits }, () => {
				throw Error("must not draw entropy");
			}),
		).toThrow(/capacity|byte/i);
	}
	const raw = new DatabaseSync(path);
	try {
		expect(raw.prepare("SELECT * FROM world_social_bootstraps").all()).toEqual(
			[],
		);
		expect(raw.prepare("SELECT * FROM world_social_resolutions").all()).toEqual(
			[],
		);
	} finally {
		raw.close();
	}
});
