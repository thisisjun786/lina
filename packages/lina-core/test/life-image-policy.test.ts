import { expect, test } from "bun:test";
import type { AvatarPolicy } from "../src/agents/visual.ts";
import {
	avatarIntentId,
	avatarPeriodicSource,
	resolveAvatarPolicy,
} from "../src/world/image-policy.ts";
import type { LifeImageSettings } from "../src/world/image-types.ts";
import { autonomySource } from "./life-autonomy-pure-fixture.ts";

function fixture() {
	const config = autonomySource().config;
	config.avatars = { mode: "automatic", intervalMs: 1000, maxPerWindow: 4 };
	const policy: AvatarPolicy = {
		worldId: "test-world",
		applyMode: "automatic",
		whilePinned: "candidate",
		schedule: { kind: "wall", epochMs: 1000 },
		eventFamilyIds: [],
	};
	const settings: LifeImageSettings = {
		version: 1,
		worldId: "test-world",
		revision: 1,
		worldVersion: 1,
		route: { provider: "synthetic", model: "image" },
		eventRules: [],
		avatarEventRules: [],
		perAuthorCooldownSteps: 0,
		attachMode: "manual",
		maxJobsPerVisit: 1,
		storage: {
			maxActiveJobs: 4,
			maxArchivedJobs: 10,
			maxAssets: 10,
			maxTotalBytes: 10_000_000,
		},
	};
	return {
		worldId: "test-world",
		agentId: "lina",
		avatarPolicyRevision: 1,
		policy,
		config,
		settings,
	};
}

test("avatar cadence identity ignores every provenance-only edit while preserving frozen records", () => {
	const f = fixture(),
		original = resolveAvatarPolicy(f),
		source = avatarPeriodicSource(original, 2500, 8);
	expect(source).toMatchObject({
		kind: "avatar_wall",
		slotIndex: 1,
		dueAtMs: 2000,
	});
	if (!source) throw Error("Missing slot");
	const identity = avatarIntentId("test-world", "lina", source);
	for (const edit of [
		() => {
			f.policy.applyMode = "manual";
		},
		() => {
			f.policy.whilePinned = "skip";
		},
		() => {
			f.policy.eventFamilyIds = ["meet"];
		},
		() => {
			if (f.config.usage) f.config.usage.maxImages += 1;
		},
		() => {
			f.settings.maxJobsPerVisit += 1;
		},
		() => {
			f.config.revision += 1;
		},
	]) {
		edit();
		f.avatarPolicyRevision += 1;
		f.settings.revision += 1;
		const next = resolveAvatarPolicy(f),
			slot = avatarPeriodicSource(next, 2500, 99);
		expect(next.id).not.toBe(original.id);
		expect(next.scheduleKey).toBe(original.scheduleKey);
		if (!slot) throw Error("Missing slot");
		expect(avatarIntentId("test-world", "lina", slot)).toBe(identity);
	}
	expect(original.policy.applyMode).toBe("automatic");
	expect(original.avatars.intervalMs).toBe(1000);
});

test("interval-only edit creates distinct cadence and periodic slot never substitutes world time for wall time", () => {
	const f = fixture(),
		first = resolveAvatarPolicy(f);
	expect(avatarPeriodicSource(first, 999, 9000)).toBeNull();
	f.config.avatars = { mode: "automatic", intervalMs: 2000, maxPerWindow: 4 };
	const next = resolveAvatarPolicy(f);
	expect(next.scheduleKey).not.toBe(first.scheduleKey);
	f.policy.schedule = { kind: "steps", epochRevision: 2, intervalSteps: 3 };
	expect(() => resolveAvatarPolicy(f)).toThrow(/ambiguous/);
	f.config.avatars.intervalMs = null;
	const steps = resolveAvatarPolicy(f);
	expect(avatarPeriodicSource(steps, 9999999, 1)).toBeNull();
	expect(avatarPeriodicSource(steps, 9999999, 9)).toMatchObject({
		kind: "avatar_steps",
		slotIndex: 2,
		dueLifeRevision: 8,
	});
});

test("event intent excludes settings/policy revisions but keeps actual immutable world/agent/event identity", () => {
	const source = {
		kind: "avatar_event" as const,
		resolvedPolicyId: "policy-a",
		eventId: "test-world:1",
		worldRevision: 1,
		lifeRevision: 1,
		familyId: "meet",
		stepId: "step",
		triggerSettingsRevision: 1,
		triggerDigest: "a".repeat(64),
	};
	const id = avatarIntentId("test-world", "lina", source);
	expect(
		avatarIntentId("test-world", "lina", {
			...source,
			resolvedPolicyId: "policy-b",
			triggerSettingsRevision: 2,
		}),
	).toBe(id);
	expect(avatarIntentId("test-world", "mira", source)).not.toBe(id);
	expect(
		avatarIntentId("test-world", "lina", {
			...source,
			eventId: "test-world:2",
		}),
	).not.toBe(id);
});

test("missing configuration and unsafe clocks fail before deriving an avatar slot", () => {
	const f = fixture();
	f.config.avatars = null;
	expect(() => resolveAvatarPolicy(f)).toThrow();
	f.config.avatars = { mode: "manual", intervalMs: null, maxPerWindow: 1 };
	expect(() => resolveAvatarPolicy(f)).toThrow();
	f.config.avatars.intervalMs = 1000;
	f.policy.worldId = "foreign";
	expect(() => resolveAvatarPolicy(f)).toThrow();
	f.policy.worldId = "test-world";
	expect(() =>
		avatarPeriodicSource(
			resolveAvatarPolicy(f),
			Number.MAX_SAFE_INTEGER + 1,
			1,
		),
	).toThrow();
});
