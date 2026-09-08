import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentStore } from "../src/agents/store.ts";
import { requireVisualRecord } from "../src/agents/visual-validation.ts";

let dir: string, store: AgentStore;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "lina-avatar-capacity-"));
	store = new AgentStore(join(dir, "agents.sqlite"));
	store.create({
		id: "lina",
		name: "Lina",
		role: "assistant",
		personality: "curious",
		voice: "warm",
		profile: "lore",
		appearance: "eyes",
		interests: [],
		avatarId: null,
		evolution: "adaptive",
	});
});
afterEach(() => {
	store.close();
	rmSync(dir, { recursive: true, force: true });
});
const reservation = (id: string) => ({
	reservationId: id,
	owner: { kind: "manual" as const, agentId: "lina", requestKey: id },
	maxBytes: 2097152,
});
test("installation inventory includes orphan files and competes durably across worlds and manual uploads", () => {
	store.updateVisual("lina", 1, {
		anchors: [],
		canonicalReferenceId: null,
		textIdentity: null,
		avatarPolicy: null,
		referenceLimits: null,
		maxHistoryRecords: 1000,
	});
	const files = Array.from({ length: 127 }, (_, i) => ({
		fileId: `orphan-${i}`,
		sha256: i.toString(16).padStart(64, "0"),
		mime: "image/png" as const,
		size: 2097152,
	}));
	store.syncAvatarInventory(files);
	store.reserveAvatarCapacity({
		...reservation("world-one"),
		owner: {
			kind: "generated",
			agentId: "lina",
			worldId: "one",
			intentId: "intent",
			attemptId: "attempt",
		},
	});
	const second = new AgentStore(join(dir, "agents.sqlite"));
	try {
		expect(() => second.reserveAvatarCapacity(reservation("manual"))).toThrow(
			/capacity/,
		);
		expect(() =>
			second.reserveAvatarCapacity({
				...reservation("world-two"),
				owner: {
					kind: "generated",
					agentId: "lina",
					worldId: "two",
					intentId: "intent",
					attemptId: "attempt",
				},
			}),
		).toThrow(/capacity/);
	} finally {
		second.close();
	}
	expect(store.avatarAuthorities(requireVisualRecord(files[0]).sha256)).toEqual(
		[],
	);
	store.close();
	store = new AgentStore(join(dir, "agents.sqlite"));
	expect(store.avatarCapacity()).toEqual({
		files: 127,
		bytes: 266338304,
		reservedFiles: 1,
		reservedBytes: 2097152,
	});
	store.releaseAvatarCapacity("world-one");
	store.reserveAvatarCapacity(reservation("manual"));
	const actual = {
		fileId: "new.png",
		sha256: "f".repeat(64),
		mime: "image/png" as const,
		size: 100,
	};
	store.settleAvatarCapacity("manual", actual);
	expect(store.avatarCapacity()).toEqual({
		files: 128,
		bytes: 266338404,
		reservedFiles: 0,
		reservedBytes: 0,
	});
	expect(store.settleAvatarCapacity("manual", actual).state).toBe("settled");
	expect(() =>
		store.settleAvatarCapacity("manual", { ...actual, size: 101 }),
	).toThrow(/conflict/);
});
test("inventory adoption counts a crash orphan once and duplicate hash releases reserved bytes", () => {
	store.syncAvatarInventory([]);
	store.reserveAvatarCapacity(reservation("first"));
	const asset = {
		fileId: "a.png",
		sha256: "a".repeat(64),
		mime: "image/png" as const,
		size: 100,
	};
	store.syncAvatarInventory([asset]);
	store.settleAvatarCapacity("first", asset);
	expect(store.avatarCapacity()).toEqual({
		files: 1,
		bytes: 100,
		reservedFiles: 0,
		reservedBytes: 0,
	});
	store.reserveAvatarCapacity(reservation("second"));
	store.settleAvatarCapacity("second", asset);
	expect(store.avatarCapacity()).toEqual({
		files: 1,
		bytes: 100,
		reservedFiles: 0,
		reservedBytes: 0,
	});
	expect(() => store.syncAvatarInventory([{ ...asset, size: 101 }])).toThrow(
		/conflict/,
	);
	expect(() =>
		store.reserveAvatarCapacity({ ...reservation("large"), maxBytes: 2097153 }),
	).toThrow();
	store.close();
	store = new AgentStore(join(dir, "agents.sqlite"));
	expect(store.avatarCapacity().bytes).toBe(100);
});

test("explicit manual upload is independently authorized without autonomous history budgets", () => {
	store.syncAvatarInventory([]);
	const asset = {
		sha256: "a".repeat(64),
		mime: "image/png" as const,
		size: 100,
	};
	store.reserveAvatarCapacity({ ...reservation("manual"), maxBytes: 100 });
	store.settleAvatarCapacity("manual", { fileId: "a.png", ...asset });
	store.applyReflection(
		"lina",
		{
			profileRevision: 1,
			dynamicsRevision: 0,
			requestId: "learn",
			sourceEntryIds: ["user"],
			interests: ["jazz"],
		},
		() => true,
	);
	const input = {
		requestKey: "upload",
		expectedProfileRevision: 1,
		expectedVisualRevision: 1,
		asset,
		source: { kind: "upload" as const },
	};
	expect(() => store.applyManualAvatarOnce("lina", input, () => false)).toThrow(
		/authority/,
	);
	const receipt = store.applyManualAvatarOnce("lina", input, () => true);
	expect(store.pendingGrowth("lina").interests).toEqual(["jazz"]);
	expect(store.visual("lina").maxHistoryRecords).toBeNull();
	store.update("lina", 2, { avatarId: "b".repeat(64) });
	store.close();
	store = new AgentStore(join(dir, "agents.sqlite"));
	expect(store.applyManualAvatarOnce("lina", input, () => false)).toEqual(
		receipt,
	);
	expect(store.get("lina")?.avatarId).toBe("b".repeat(64));
	expect(store.avatarAuthorities(asset.sha256)).toHaveLength(1);
	store.revokeAvatarAuthority("lina", receipt.authorityId);
	expect(store.avatarAuthorities(asset.sha256)).toEqual([]);
	expect(() =>
		store.applyManualAvatarOnce(
			"lina",
			{
				...input,
				requestKey: "restore",
				expectedProfileRevision: 3,
				expectedVisualRevision: 3,
				source: { kind: "restore", authorityId: receipt.authorityId },
			},
			() => true,
		),
	).toThrow(/authority/);
});
