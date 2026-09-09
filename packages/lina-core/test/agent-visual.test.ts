import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { AgentStore } from "../src/agents/store.ts";

let dir: string;
let store: AgentStore;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "lina-visual-"));
	store = new AgentStore(join(dir, "agents.sqlite"), () => 100);
	store.create({
		id: "lina",
		name: "Lina",
		role: "assistant",
		personality: "curious",
		voice: "warm",
		profile: "private lore",
		appearance: "silver eyes",
		interests: [],
		avatarId: null,
		evolution: "adaptive",
	});
});
afterEach(() => {
	store.close();
	rmSync(dir, { recursive: true, force: true });
});

test("BUG-R1 avatar-only generic patch preserves pending growth and learned history", () => {
	store.applyReflection(
		"lina",
		{
			profileRevision: 1,
			dynamicsRevision: 0,
			requestId: "proposal",
			sourceEntryIds: ["source"],
			interests: ["jazz"],
		},
		() => true,
	);
	const before = store.dynamics("lina");
	const db = new DatabaseSync(join(dir, "agents.sqlite"));
	const learnedBefore = db
		.prepare("SELECT * FROM agent_learning_history")
		.all();
	store.update("lina", 1, { avatarId: "a".repeat(64) });
	expect(store.pendingGrowth("lina").interests).toEqual(["jazz"]);
	expect(store.dynamics("lina")).toEqual(before);
	expect(db.prepare("SELECT * FROM agent_learning_history").all()).toEqual(
		learnedBefore,
	);
	db.close();
	store.close();
	store = new AgentStore(join(dir, "agents.sqlite"), () => 100);
	expect(store.pendingGrowth("lina").interests).toEqual(["jazz"]);
	expect(store.visual("lina").revision).toBe(2);
	expect(store.avatarAuthorities("a".repeat(64))).toEqual([]);
});

test("new visual identity explicitly denies unset reference and history budgets", () => {
	expect(store.visual("lina")).toMatchObject({
		revision: 1,
		avatarPolicyRevision: 0,
		avatarPolicy: null,
		referenceLimits: null,
		maxHistoryRecords: null,
		canonicalReferenceId: null,
		textIdentity: null,
		pinned: false,
	});
	expect(() =>
		store.registerVisualReference("lina", 1, 1, {
			version: 1,
			id: "ref",
			agentId: "lina",
			assetId: "owned",
			sha256: "b".repeat(64),
			size: 100,
			mime: "image/png",
			origin: { kind: "upload" },
		}),
	).toThrow(/reference.*(capacity|configured|limit)/);
});

test("visual policies/grants keep immutable subjects, revisions, and distinct destination permission", () => {
	let v = store.updateVisual("lina", 1, {
		anchors: ["silver eyes"],
		textIdentity: "approved identity",
		canonicalReferenceId: null,
		avatarPolicy: {
			worldId: "world",
			applyMode: "automatic",
			whilePinned: "candidate",
			schedule: { kind: "wall", epochMs: 0 },
			eventFamilyIds: [],
		},
		referenceLimits: { maxAssets: 1, maxTotalBytes: 200 },
		maxHistoryRecords: 100,
	});
	expect(v.avatarPolicyRevision).toBe(1);
	const reference = {
		version: 1 as const,
		id: "ref",
		agentId: "lina",
		assetId: "owned",
		sha256: "b".repeat(64),
		size: 100,
		mime: "image/png" as const,
		origin: { kind: "upload" as const },
	};
	store.registerVisualReference("lina", 1, v.revision, reference);
	v = store.visual("lina");
	const grant = {
		version: 1 as const,
		id: "grant",
		agentId: "lina",
		revision: 1,
		subject: {
			kind: "reference" as const,
			referenceId: "ref",
			sha256: reference.sha256,
		},
		providerUse: true,
		purposes: [{ kind: "avatar" as const }],
		revoked: false,
	};
	store.putVisualGrant("lina", v.revision, grant);
	v = store.visual("lina");
	const {
		version: _v,
		agentId: _a,
		revision: _r,
		profileRevision: _p,
		avatarPolicyRevision: _ap,
		pinned: _pin,
		...input
	} = v;
	v = store.updateVisual("lina", v.revision, {
		...input,
		canonicalReferenceId: "ref",
	});
	const frozen = store.freezeVisualIdentity("lina", { kind: "avatar" });
	expect(frozen.reference).toEqual(reference);
	expect(frozen.grants).toEqual([
		{ grantId: "grant", revision: 1, purpose: { kind: "avatar" } },
	]);
	store.putVisualGrant("lina", v.revision, {
		...grant,
		revision: 2,
		providerUse: false,
	});
	expect(store.visualIdentityAllowed(frozen, "provider")).toBe(false);
	expect(store.visualIdentityAllowed(frozen, "destination")).toBe(true);
	expect(() =>
		store.putVisualGrant("lina", store.visual("lina").revision, {
			...grant,
			revision: 3,
			subject: { kind: "text_identity", identityDigest: "c".repeat(64) },
		}),
	).toThrow(/subject/);
	store.putVisualGrant("lina", store.visual("lina").revision, {
		...grant,
		revision: 3,
		purposes: [],
	});
	expect(store.visualIdentityAllowed(frozen, "destination")).toBe(false);
	expect(store.visualAt("lina", v.revision)).toEqual(v);
	store.close();
	store = new AgentStore(join(dir, "agents.sqlite"));
	expect(store.visualGrantAt("lina", "grant", 1)).toEqual(grant);
	expect(store.visual("lina").avatarPolicyRevision).toBe(1);
});

test("a later grant revision cannot be forged into an earlier frozen identity", () => {
	const input = {
		anchors: ["silver eyes"],
		textIdentity: "approved identity",
		canonicalReferenceId: null,
		avatarPolicy: null,
		referenceLimits: { maxAssets: 1, maxTotalBytes: 200 },
		maxHistoryRecords: 100,
	};
	store.updateVisual("lina", 1, input);
	const grant = {
		version: 1 as const,
		id: "text",
		agentId: "lina",
		revision: 1,
		subject: {
			kind: "text_identity" as const,
			identityDigest: visualIdentityDigest(input),
		},
		providerUse: true,
		purposes: [{ kind: "avatar" as const }],
		revoked: false,
	};
	store.putVisualGrant("lina", 2, grant);
	const frozen = store.freezeVisualIdentity("lina", { kind: "avatar" });
	store.putVisualGrant("lina", 3, {
		...grant,
		revision: 2,
		purposes: [
			{ kind: "avatar" },
			{ kind: "life", worldId: "world", recipientId: "friend" },
		],
	});
	expect(() =>
		store.validateFrozenVisualIdentity({
			...frozen,
			grants: [{ grantId: "text", revision: 2, purpose: { kind: "avatar" } }],
		}),
	).toThrow(/historical/);
	expect(() => store.validateFrozenVisualIdentity(frozen)).not.toThrow();
});

import {
	parseVisualReference,
	visualIdentityDigest,
} from "../src/agents/visual-validation.ts";

test("new generic profile hashes cannot mint captured legacy provenance; seed import is explicit", () => {
	const asset = {
		sha256: "a".repeat(64),
		mime: "image/png" as const,
		size: 100,
	};
	store.create({
		id: "other",
		name: "Other",
		role: "assistant",
		personality: "curious",
		voice: "warm",
		profile: "lore",
		appearance: "eyes",
		interests: [],
		avatarId: asset.sha256,
		evolution: "adaptive",
	});
	store.syncAvatarInventory([{ fileId: "a.png", ...asset }]);
	expect(() => store.registerLegacyAvatar("other", asset, () => true)).toThrow(
		/source/,
	);
	store.registerSeedAvatar("other", asset, "pack-avatar", () => true);
	expect(store.avatarAuthorities(asset.sha256)).toHaveLength(1);
	store.close();
	store = new AgentStore(join(dir, "agents.sqlite"));
	expect(store.avatarAuthorities(asset.sha256)[0]).toMatchObject({
		kind: "legacy",
		source: { kind: "seed", sourceId: "pack-avatar" },
	});
});

test("reference DTO rejects filesystem paths and provider URLs as owned asset IDs", () => {
	const input = {
		version: 1,
		id: "ref",
		agentId: "lina",
		assetId: "owned",
		sha256: "b".repeat(64),
		size: 100,
		mime: "image/png",
		origin: { kind: "upload" },
	};
	for (const assetId of [
		"/tmp/private.png",
		"../private.png",
		"https://provider.test/image.png",
	])
		expect(() => parseVisualReference({ ...input, assetId })).toThrow(/asset/);
});
