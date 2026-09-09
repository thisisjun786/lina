import { expect, test } from "bun:test";
import { sourceFixture } from "./source-provenance-fixture.ts";

test("native prompt reserves its source owner before awaited context preparation", async () => {
	const f = sourceFixture(),
		entered = Promise.withResolvers<void>(),
		release = Promise.withResolvers<void>();
	let first = true;
	const opened = await f.open({
		register(host) {
			host.on("before_agent_start", async () => {
				if (first) {
					first = false;
					entered.resolve();
					await release.promise;
				}
			});
		},
	});
	f.journal.createRequest("A", "hi");
	f.journal.createRequest("B", "hi");
	const controller = new AbortController();
	const admission = (requestId: string) => ({
		requestId,
		signal: controller.signal,
		disposition() {},
		rejected() {},
	});
	const a = opened.session.prompt("hi", admission("A")).catch((error) => error);
	let b: Promise<unknown> | undefined;
	try {
		await entered.promise;
		const dispatched = opened.rpc.next("turn/start");
		b = opened.session.prompt("hi", admission("B")).catch((error) => error);
		const outcome = await Promise.race([
			b.then((error) => ({ kind: "rejected", error })),
			dispatched.then(() => ({ kind: "dispatched", error: null })),
		]);
		expect(outcome.kind).toBe("rejected");
		expect(String(outcome.error)).toContain("already active");
		expect(f.journal.requestSourcePolicy("B")).toBeUndefined();
		release.resolve();
		await dispatched;
		opened.rpc.complete(opened.session.threadId);
		expect(await a).toBeUndefined();
		expect(f.journal.requestSourcePolicy("A")?.scope).toBe("ordinary");
	} finally {
		release.resolve();
		controller.abort();
		opened.rpc.close();
		await Promise.allSettled([a, ...(b ? [b] : [])]);
		await f.close();
	}
});
