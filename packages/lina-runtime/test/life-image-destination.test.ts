import { expect, test } from "bun:test";
import { dirname } from "node:path";
import { hash } from "../../lina-core/src/attachments/validation.ts";
import { AvatarAssets } from "../src/fleet/avatar-assets.ts";
import { lifeAvatarReservationId } from "../src/images/life-authority.ts";
import { LifeImageDestinations } from "../src/images/life-destinations.ts";
import { lifeImagePorts } from "../src/images/life-ports.ts";
import { png } from "./ima2-client-fixture.ts";
import { finalAuthorityFixture } from "./life-image-final-authority-fixture.ts";

test("verified generation becomes an avatar candidate and applies once without changing persona or learning", async () => {
	const f = finalAuthorityFixture();
	try {
		await f.jobs.startPrepared(f.job.id, f.authority);
		const world = f.services.world;
		const ports = lifeImagePorts({
			...f.services,
			root: dirname(f.path),
			owner: f.intent.owner,
			assertLease: () => {},
			resolveReference: () => {
				throw Error("No reference");
			},
			onComplete: () => {},
		});
		const queued = f.store.update(f.job.id, { resultFilename: "result.png" });
		const artifact = await ports.artifacts.importOutput(queued, {
			bytes: png,
			mime: "image/png",
		});
		const job = f.store.update(f.job.id, { state: "completed", artifact });
		ports.changed(job);
		const assets: AvatarAssets = new AvatarAssets(
			dirname(f.path),
			f.agents,
			(authority) => destination.allowed(authority.candidate),
		);
		const destination: LifeImageDestinations = new LifeImageDestinations({
			...f.services,
			root: dirname(f.path),
			avatars: assets,
			read: () => f.store.get(job.id),
		});
		const before = f.agents.get("lina"),
			learning = f.agents.dynamics("lina");
		const applied = destination.avatar(job, "automatic");
		expect(applied.status).toBe("applied");
		expect(f.agents.get("lina")?.avatarId).toBe(hash(png));
		expect(f.agents.get("lina")?.personality).toBe(before?.personality);
		expect(f.agents.dynamics("lina")).toEqual(learning);
		expect(
			f.agents.avatarCapacityReservation(
				lifeAvatarReservationId("test-world", f.attempt.attemptId),
			)?.state,
		).toBe("settled");
		const revision = f.agents.get("lina")?.revision;
		expect(destination.avatar(job, "automatic")).toEqual(applied);
		expect(f.agents.get("lina")?.revision).toBe(revision);
		expect(
			world.imageAttempt("test-world", f.attempt.attemptId)?.delivery.kind,
		).toBe("avatar");
		expect(assets.globalAuthority(hash(png))).toBe(true);
		f.revokeWork();
		expect(assets.globalAuthority(hash(png))).toBe(false);
		expect(f.agents.avatarHistory("lina")).toHaveLength(1);
	} finally {
		await f.close();
	}
});
