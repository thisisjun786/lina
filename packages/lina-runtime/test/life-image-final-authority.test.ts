import { expect, test } from "bun:test";
import { lifeAvatarReservationId } from "../src/images/life-authority.ts";
import { finalAuthorityFixture } from "./life-image-final-authority-fixture.ts";

test("actual client POST uses the exact world-linked UUID once and durably marks image usage", async () => {
	const f = finalAuthorityFixture();
	try {
		expect((await f.jobs.startPrepared(f.job.id, f.authority)).state).toBe(
			"queued",
		);
		expect(f.posts()).toBe(1);
		expect(
			f.services.world.imageAttempt("test-world", f.attempt.attemptId)?.jobId,
		).toBe(f.job.id);
		expect(
			f.services.world.imageAttemptCount("test-world", f.attempt.attemptId)
				?.state,
		).toBe("unknown");
		await f.jobs.startPrepared(f.job.id, f.authority);
		expect(f.posts()).toBe(1);
	} finally {
		await f.close();
	}
});

test("revocation during actual client catalog preparation denies POST and preserves undispatched reservation", async () => {
	const f = finalAuthorityFixture(true);
	try {
		const running = f.jobs.startPrepared(f.job.id, f.authority);
		await f.prepared.promise;
		f.agents.putVisualGrant("lina", f.agents.visual("lina").revision, {
			...f.grant,
			revision: 2,
			revoked: true,
		});
		f.release.resolve();
		expect((await running).state).toBe("prepared");
		expect(f.posts()).toBe(0);
		expect(
			f.services.world.imageAttemptCount("test-world", f.attempt.attemptId)
				?.dispatchAtMs,
		).toBeNull();
	} finally {
		await f.close();
	}
});

test("foreground admission and missing shared avatar reservation both refuse the final POST", async () => {
	for (const kind of ["foreground", "reservation"] as const) {
		const f = finalAuthorityFixture();
		try {
			if (kind === "foreground") f.foreground();
			else
				f.agents.releaseAvatarCapacity(
					lifeAvatarReservationId("test-world", f.attempt.attemptId),
				);
			expect((await f.jobs.startPrepared(f.job.id, f.authority)).state).toBe(
				"prepared",
			);
			expect(f.posts()).toBe(0);
		} finally {
			await f.close();
		}
	}
});
