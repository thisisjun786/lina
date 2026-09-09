import { expect, test } from "bun:test";
import { avatarPeriodicSource } from "../../lina-core/src/world/image-policy.ts";
import { imageAvatarPolicy } from "../../lina-core/test/life-image-store-fixture.ts";
import {
	assertLifeImageAuthority,
	assertLifeImageHistory,
} from "../src/images/life-permissions.ts";
import { lifeImagePermissionsFixture as fixture } from "./life-image-permissions-fixture.ts";

test("image history joins real WorldStore policy with original AgentStore visual and grant snapshots", () => {
	const f = fixture();
	try {
		expect(
			assertLifeImageHistory(f.services, "test-world", f.intent.intentId),
		).toEqual(f.intent);
		expect(
			assertLifeImageAuthority(
				f.services,
				"test-world",
				f.intent.intentId,
				"provider",
			),
		).toEqual(f.intent);
		expect(f.checks()).toBe(1);
		expect(f.intent.material.prompt).not.toContain("Private biography");
	} finally {
		f.close();
	}
});

test("today's provider permission is independent from retained avatar display permission", () => {
	const f = fixture();
	try {
		f.agents.putVisualGrant("lina", f.agents.visual("lina").revision, {
			...f.grant,
			revision: 2,
			providerUse: false,
		});
		expect(() =>
			assertLifeImageAuthority(
				f.services,
				"test-world",
				f.intent.intentId,
				"provider",
			),
		).toThrow();
		expect(
			assertLifeImageHistory(f.services, "test-world", f.intent.intentId),
		).toEqual(f.intent);
		expect(
			assertLifeImageAuthority(
				f.services,
				"test-world",
				f.intent.intentId,
				"destination",
			),
		).toEqual(f.intent);
		f.agents.putVisualGrant("lina", f.agents.visual("lina").revision, {
			...f.grant,
			revision: 3,
			providerUse: false,
			purposes: [],
		});
		expect(() =>
			assertLifeImageAuthority(
				f.services,
				"test-world",
				f.intent.intentId,
				"destination",
			),
		).toThrow();
	} finally {
		f.close();
	}
});

test("a fabricated policy snapshot with the same policy revision cannot borrow real visual authority", () => {
	const f = fixture();
	try {
		const forged = f.store.resolveImageAvatarPolicy("test-world", "lina", 1, {
			...imageAvatarPolicy,
			applyMode: "manual",
		});
		const source = avatarPeriodicSource(
			forged,
			f.clock(),
			f.store.lifeSnapshot("test-world").revision,
		);
		if (!source) throw Error("Missing source");
		const intent = f.store.freezeImageIntent({
			...f.input,
			source,
			requestKey: "forged-policy",
		});
		expect(() =>
			assertLifeImageHistory(f.services, "test-world", intent.intentId),
		).toThrow(/policy/);
	} finally {
		f.close();
	}
});

test("live work-source withdrawal rejects effects and bytes even when original history remains", () => {
	const f = fixture();
	try {
		f.revokeWork();
		expect(() =>
			assertLifeImageAuthority(
				f.services,
				"test-world",
				f.intent.intentId,
				"destination",
			),
		).toThrow("Task source changed");
		expect(
			assertLifeImageHistory(f.services, "test-world", f.intent.intentId),
		).toEqual(f.intent);
	} finally {
		f.close();
	}
});
