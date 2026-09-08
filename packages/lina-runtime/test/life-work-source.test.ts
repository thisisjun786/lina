import { expect, test } from "bun:test";
import { createWorkBridge } from "../src/life/work-bridge.ts";
import { assertWorkSourceCurrent } from "../src/life/work-source.ts";
import { workBridgeFixture } from "./helpers/work-bridge.ts";

test("failed restriction delivery cannot keep a frozen or retained work snapshot eligible", async () => {
	const f = await workBridgeFixture();
	const bridge = createWorkBridge({
		source: f.tasks,
		world: f.world.store,
		onError() {},
	});
	try {
		bridge.start();
		await f.share();
		const frozen = f.world.store.workEvidence(f.worldId);
		expect(() => assertWorkSourceCurrent(f.tasks, frozen)).not.toThrow();
		bridge.close();
		await f.share(null);
		const pending = f.tasks.pendingWorkDeliveries()[0];
		if (!pending) throw Error("Missing restriction");
		f.tasks.recordWorkDeliveryAttempt(
			pending.deliveryId,
			pending.payloadDigest,
			"failed",
			"destination_unavailable",
		);
		expect(f.world.store.workEvidence(f.worldId)).toEqual(frozen);
		expect(() => assertWorkSourceCurrent(f.tasks, frozen)).toThrow(
			"authority changed",
		);
		expect(() => assertWorkSourceCurrent(undefined, frozen)).toThrow(
			"authority changed",
		);
		const recover = createWorkBridge({
			source: f.tasks,
			world: f.world.store,
			onError() {},
		});
		recover.start();
		f.tasks.retryWorkDelivery(pending.deliveryId, pending.payloadDigest);
		const restricted = f.world.store.workEvidence(f.worldId);
		expect(restricted.records[0]?.source.operation).toBe("restrict");
		expect(() => assertWorkSourceCurrent(f.tasks, restricted)).not.toThrow();
		recover.close();
	} finally {
		bridge.close();
		await f.close();
	}
});
