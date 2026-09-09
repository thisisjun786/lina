import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentStore } from "../../lina-core/src/agents/store.ts";
import { visualIdentityDigest } from "../../lina-core/src/agents/visual-validation.ts";
import { imageStoreFixture } from "../../lina-core/test/life-image-store-fixture.ts";
import { LifeImageDiscovery } from "../src/images/life-discovery.ts";

function fixture(epochMs = 1000, intervalMs = 1000) {
	const world = imageStoreFixture();
	const root = mkdtempSync(join(tmpdir(), "lina-image-discovery-"));
	const agents = new AgentStore(join(root, "agents.sqlite"));
	agents.create({
		id: "lina",
		name: "Lina",
		role: "resident",
		personality: "calm",
		voice: "warm",
		profile: "fictional",
		appearance: "fictional",
		interests: [],
		avatarId: null,
		evolution: "adaptive",
	});
	const input = {
		anchors: ["blue hair"],
		canonicalReferenceId: null,
		textIdentity: "approved Lina identity",
		avatarPolicy: {
			worldId: "test-world",
			applyMode: "automatic" as const,
			whilePinned: "candidate" as const,
			schedule: { kind: "wall" as const, epochMs },
			eventFamilyIds: [],
		},
		referenceLimits: { maxAssets: 1, maxTotalBytes: 1000 },
		maxHistoryRecords: 10,
	};
	agents.updateVisual("lina", 1, input);
	agents.putVisualGrant("lina", 2, {
		version: 1,
		id: "avatar-grant",
		agentId: "lina",
		revision: 1,
		subject: {
			kind: "text_identity",
			identityDigest: visualIdentityDigest(input),
		},
		providerUse: true,
		purposes: [{ kind: "avatar" }],
		revoked: false,
	});
	const current = world.store.lifeConfig("test-world");
	const { worldId: _worldId, revision, ...config } = current;
	world.store.setLifeConfig("test-world", revision, {
		...config,
		avatars: { mode: "automatic", intervalMs, maxPerWindow: 3 },
		usage: {
			windowMs: 1000,
			maxImages: 3,
			maxInputTokens: 100,
			maxOutputTokens: 100,
		},
	});
	return {
		world,
		agents,
		discovery: new LifeImageDiscovery(world.store, agents),
		close() {
			agents.close();
			world.close();
			rmSync(root, { recursive: true, force: true });
		},
	};
}

function addAvatarAgent(agents: AgentStore, id: string, epochMs: number): void {
	agents.create({
		id,
		name: id,
		role: "resident",
		personality: "calm",
		voice: "warm",
		profile: "fictional",
		appearance: "fictional",
		interests: [],
		avatarId: null,
		evolution: "adaptive",
	});
	const input = {
		anchors: [id],
		canonicalReferenceId: null,
		textIdentity: `approved ${id} identity`,
		avatarPolicy: {
			worldId: "test-world",
			applyMode: "automatic" as const,
			whilePinned: "candidate" as const,
			schedule: { kind: "wall" as const, epochMs },
			eventFamilyIds: [],
		},
		referenceLimits: { maxAssets: 1, maxTotalBytes: 1000 },
		maxHistoryRecords: 10,
	};
	agents.updateVisual(id, 1, input);
	agents.putVisualGrant(id, 2, {
		version: 1,
		id: `${id}-avatar-grant`,
		agentId: id,
		revision: 1,
		subject: {
			kind: "text_identity",
			identityDigest: visualIdentityDigest(input),
		},
		providerUse: true,
		purposes: [{ kind: "avatar" }],
		revoked: false,
	});
}

test("BUG-R070 wall avatar visit arms the next periodic deadline after freezing its current slot", () => {
	const f = fixture();
	try {
		const first = f.discovery.preview("test-world", 1000);
		expect(first.status).toBe("ready");
		expect(first.dueAtMs).toBe(2000);
		const candidate = first.candidates.find(
			(x) => x.reason === "periodic_avatar_due",
		);
		if (!candidate) throw Error("Missing current wall slot");
		f.discovery.freeze("test-world", candidate);
		const afterFreeze = f.discovery.preview("test-world", 1000);
		expect(afterFreeze.candidates).toEqual([]);
		expect(afterFreeze.dueAtMs).toBe(2000);
		const next = f.discovery.preview("test-world", 2000);
		expect(next.candidates).toHaveLength(1);
		expect(next.candidates[0]?.source).toMatchObject({
			kind: "avatar_wall",
			slotIndex: 1,
			dueAtMs: 2000,
		});
		expect(next.dueAtMs).toBe(3000);
	} finally {
		f.close();
	}
});

test("future wall epochs and missing avatar configuration report only actionable wake state", () => {
	const future = fixture(5000);
	try {
		expect(future.discovery.preview("test-world", 1000)).toMatchObject({
			status: "hold",
			candidates: [],
			dueAtMs: 5000,
		});
	} finally {
		future.close();
	}
	const missing = fixture();
	try {
		const current = missing.world.store.lifeConfig("test-world");
		const { worldId: _worldId, revision, ...config } = current;
		missing.world.store.setLifeConfig("test-world", revision, {
			...config,
			avatars: null,
		});
		expect(missing.discovery.preview("test-world", 1000)).toMatchObject({
			status: "hold",
			candidates: [],
			dueAtMs: null,
		});
	} finally {
		missing.close();
	}
});

test("wall planning returns the earliest next deadline across configured agents and ignores pinned skip", () => {
	const f = fixture();
	try {
		addAvatarAgent(f.agents, "mira", 1500);
		const visit = f.discovery.preview("test-world", 1000);
		expect(visit.candidates.map((candidate) => candidate.agentId)).toEqual([
			"lina",
		]);
		expect(visit.dueAtMs).toBe(1500);
		const visual = f.agents.visual("lina");
		const {
			version: _version,
			agentId: _agentId,
			revision,
			profileRevision: _profileRevision,
			avatarPolicyRevision: _avatarPolicyRevision,
			pinned: _pinned,
			...input
		} = visual;
		if (!input.avatarPolicy) throw Error("Missing Lina avatar policy");
		f.agents.updateVisual("lina", revision, {
			...input,
			avatarPolicy: {
				...input.avatarPolicy,
				whilePinned: "skip",
			},
		});
		f.agents.setAvatarPinned("lina", {
			requestKey: "pin-lina",
			expectedRevision: f.agents.visual("lina").revision,
			pinned: true,
		});
		expect(f.discovery.preview("test-world", 1000)).toMatchObject({
			candidates: [],
			dueAtMs: 1500,
		});
	} finally {
		f.close();
	}
});

test("step avatar cadence returns a due candidate without inventing a wall deadline", () => {
	const f = fixture();
	try {
		const current = f.world.store.lifeConfig("test-world");
		const { worldId: _worldId, revision: configRevision, ...config } = current;
		f.world.store.setLifeConfig("test-world", configRevision, {
			...config,
			avatars: { mode: "automatic", intervalMs: null, maxPerWindow: 3 },
		});
		const visual = f.agents.visual("lina");
		const {
			version: _version,
			agentId: _agentId,
			revision,
			profileRevision: _profileRevision,
			avatarPolicyRevision: _avatarPolicyRevision,
			pinned: _pinned,
			...input
		} = visual;
		if (!input.avatarPolicy) throw Error("Missing Lina avatar policy");
		f.agents.updateVisual("lina", revision, {
			...input,
			avatarPolicy: {
				...input.avatarPolicy,
				schedule: { kind: "steps", epochRevision: 0, intervalSteps: 2 },
			},
		});
		expect(f.discovery.preview("test-world", 12345)).toMatchObject({
			status: "ready",
			dueAtMs: null,
			candidates: [
				{
					source: {
						kind: "avatar_steps",
						slotIndex: 0,
						dueLifeRevision: 0,
					},
				},
			],
		});
	} finally {
		f.close();
	}
});
