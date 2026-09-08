import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentStore } from "../../lina-core/src/agents/store.ts";
import { AvatarAssets } from "../src/fleet/avatar-assets.ts";
import type { FrozenImageReference } from "../src/images/contracts.ts";
import { png } from "./ima2-client-fixture.ts";

test("cold asset reads do not create avatar or reference directories", () => {
	const root = mkdtempSync(join(tmpdir(), "lina-avatar-cold-"));
	const agents = new AgentStore(join(root, "agents.sqlite"), () => 100);
	try {
		const assets = new AvatarAssets(root, agents, () => false);
		expect(assets.read("a".repeat(64))).toBeUndefined();
		expect(assets.readReference("lina", "reference")).toBeUndefined();
		expect(existsSync(join(root, "avatars"))).toBe(false);
		expect(existsSync(join(root, "visual-references"))).toBe(false);
	} finally {
		agents.close();
		rmSync(root, { recursive: true, force: true });
	}
});

test("manual avatar bytes require a current recorded authority", () => {
	const root = mkdtempSync(join(tmpdir(), "lina-avatar-assets-"));
	const agents = new AgentStore(join(root, "agents.sqlite"), () => 100);
	agents.create({
		id: "lina",
		name: "Lina",
		role: "assistant",
		personality: "curious",
		voice: "warm",
		profile: "profile",
		appearance: "appearance",
		interests: [],
		avatarId: null,
		evolution: "adaptive",
	});
	try {
		const assets = new AvatarAssets(root, agents, () => false);
		const asset = assets.importManual("lina", "upload-1", png, "avatar.png");
		agents.applyManualAvatarOnce(
			"lina",
			{
				requestKey: "upload-1",
				expectedProfileRevision: 1,
				expectedVisualRevision: 1,
				asset,
				source: { kind: "upload" },
			},
			(value) => value.sha256 === asset.sha256,
		);
		expect(assets.read(asset.sha256)?.bytes).toEqual(new Uint8Array(png));
		expect(assets.globalAuthority(asset.sha256)).toBe(true);
		const [authority] = agents.avatarAuthorities(asset.sha256);
		if (!authority) throw Error("missing manual authority");
		agents.revokeAvatarAuthority("lina", authority.id);
		expect(assets.globalAuthority(asset.sha256)).toBe(false);
	} finally {
		agents.close();
		rmSync(root, { recursive: true, force: true });
	}
});

test("registered reference resolution binds owner metadata and verified immutable bytes", () => {
	const root = mkdtempSync(join(tmpdir(), "lina-avatar-reference-"));
	const agents = new AgentStore(join(root, "agents.sqlite"), () => 100);
	agents.create({
		id: "lina",
		name: "Lina",
		role: "assistant",
		personality: "curious",
		voice: "warm",
		profile: "profile",
		appearance: "appearance",
		interests: [],
		avatarId: null,
		evolution: "adaptive",
	});
	try {
		const assets = new AvatarAssets(root, agents, () => false);
		const stored = assets.referenceAsset(png, "reference.png");
		assets.writeReference("lina", "reference-1", stored, png);
		const visual = agents.updateVisual("lina", 1, {
			anchors: [],
			canonicalReferenceId: null,
			textIdentity: null,
			avatarPolicy: null,
			referenceLimits: { maxAssets: 1, maxTotalBytes: png.length },
			maxHistoryRecords: 10,
		});
		agents.registerVisualReference("lina", 1, visual.revision, {
			version: 1,
			id: "reference-1",
			agentId: "lina",
			assetId: "reference-1",
			sha256: stored.sha256,
			mime: stored.mime,
			size: stored.size,
			origin: { kind: "upload" },
		});
		const reference: FrozenImageReference = {
			owner: { kind: "agent", agentId: "lina" },
			referenceId: "reference-1",
			assetId: "reference-1",
			sha256: stored.sha256,
			mime: stored.mime,
			size: stored.size,
		};
		expect(assets.resolveReference(reference)).toEqual({
			bytes: new Uint8Array(png),
			mime: "image/png",
		});
		expect(() =>
			assets.resolveReference({ ...reference, sha256: "a".repeat(64) }),
		).toThrow(/metadata/);
	} finally {
		agents.close();
		rmSync(root, { recursive: true, force: true });
	}
});

test("generated imports reject a bound overflow before writing and require exact settled bytes", () => {
	const root = mkdtempSync(join(tmpdir(), "lina-avatar-generated-"));
	const agents = new AgentStore(join(root, "agents.sqlite"), () => 100);
	agents.create({
		id: "lina",
		name: "Lina",
		role: "assistant",
		personality: "curious",
		voice: "warm",
		profile: "profile",
		appearance: "appearance",
		interests: [],
		avatarId: null,
		evolution: "adaptive",
	});
	try {
		const assets = new AvatarAssets(root, agents, () => false);
		assets.syncInventory();
		agents.updateVisual("lina", 1, {
			anchors: [],
			canonicalReferenceId: null,
			textIdentity: null,
			avatarPolicy: null,
			referenceLimits: null,
			maxHistoryRecords: 10,
		});
		agents.reserveAvatarCapacity({
			reservationId: "generated-1",
			owner: {
				kind: "generated",
				agentId: "lina",
				worldId: "world",
				intentId: "intent",
				attemptId: "attempt",
			},
			maxBytes: 1,
		});
		expect(() =>
			assets.importGenerated("generated-1", png, "avatar.png"),
		).toThrow(/exceeds/);
		expect(assets.read("a".repeat(64))).toBeUndefined();
		const asset = assets.importManual("lina", "manual-1", png, "avatar.png");
		agents.reserveAvatarCapacity({
			reservationId: "generated-2",
			owner: {
				kind: "generated",
				agentId: "lina",
				worldId: "world",
				intentId: "intent-2",
				attemptId: "attempt-2",
			},
			maxBytes: png.length,
		});
		agents.settleAvatarCapacity("generated-2", {
			fileId: "wrong-settlement.png",
			...asset,
		});
		expect(() =>
			assets.importGenerated("generated-2", png, "avatar.png"),
		).toThrow(/settlement/);
	} finally {
		agents.close();
		rmSync(root, { recursive: true, force: true });
	}
});
