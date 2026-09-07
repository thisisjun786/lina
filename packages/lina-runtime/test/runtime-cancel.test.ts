import { afterEach, expect, test } from "bun:test";
import { setImmediate as nextCheckPhase } from "node:timers/promises";
import { createRuntimeFixture } from "./runtime-fixture.ts";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const close of cleanup.splice(0).reverse()) await close();
});
function fixture(options: { beforeAbort?: () => void } = {}) {
	const f = createRuntimeFixture(options);
	cleanup.push(f.close);
	return f;
}

test("preflight remains addressable beyond the latest20 requests and cancels without a native start", async () => {
	let gateAborts = 0;
	const { native, runtime, store } = fixture({
		beforeAbort: () => {
			gateAborts++;
		},
	});
	const entered = Promise.withResolvers<void>();
	native.onPrompt = (_text, admission) => {
		entered.resolve();
		return new Promise((_resolve, reject) =>
			admission.signal.addEventListener(
				"abort",
				() => reject(new Error("preflight aborted")),
				{ once: true },
			),
		);
	};
	native.abort = async () => {}; // A never-started native run emits no settlement.
	for (let i = 0; i < 23; i++) runtime.submit(`r${i}`, `request ${i}`);
	await entered.promise;
	expect(runtime.snapshot().requests.some((row) => row.id === "r0")).toBe(
		false,
	);
	expect(runtime.cancelRequestId()).toBe("r0");
	expect(runtime.snapshot().state).toBe("running");
	await runtime.cancel("r0");
	expect(native.calls).toEqual(["request 0"]);
	expect(gateAborts).toBe(1);
	for (let i = 0; i < 23; i++)
		expect(store.request(`r${i}`)?.status).toBe("interrupted");
	expect(runtime.cancelRequestId()).toBeNull();
	expect(runtime.isCancelling).toBe(false);
});

test("an early abort receipt cannot complete cancellation before the native settled boundary", async () => {
	const { native, runtime, store } = fixture();
	const work = Promise.withResolvers<void>(),
		aborted = Promise.withResolvers<void>();
	native.onPrompt = (text, admission) => {
		native.emit({ type: "agent_start" });
		native.user("active-user", text);
		admission.disposition("started");
		return work.promise;
	};
	native.abort = async () => {
		aborted.resolve();
	};
	runtime.submit("r", "work");
	let finished = false;
	const cancel = runtime.cancel("r").then(() => {
		finished = true;
	});
	await aborted.promise;
	// Check-phase is an event-loop barrier, not an elapsed-time success assertion.
	await nextCheckPhase();
	expect(finished).toBe(false);
	expect(runtime.isCancelling).toBe(true);
	expect(store.request("r")?.status).toBe("accepted");
	expect(() =>
		runtime.submit("late", "must not enter during cancellation"),
	).toThrow();
	native.emit({ type: "agent_settled" });
	work.resolve();
	await cancel;
	expect(store.request("r")?.status).toBe("interrupted");
	expect(runtime.isCancelling).toBe(false);
});

test("cancel catches a native run that starts after the first abort during handoff", async () => {
	const { native, runtime, store } = fixture();
	const work = Promise.withResolvers<void>();
	let aborts = 0,
		cancel: Promise<void> | undefined;
	native.abort = async () => {
		aborts++;
		if (native.hasActiveRun()) {
			native.emit({ type: "agent_settled" });
			work.resolve();
		}
	};
	const off = runtime.subscribe((event) => {
		if (
			event.type === "snapshot" &&
			event.snapshot.requests.some(
				(row) => row.id === "r" && row.status === "accepted",
			) &&
			!cancel
		) {
			// Assign a placeholder before the synchronous cancellation-state publication.
			cancel = Promise.resolve();
			cancel = runtime.cancel("r");
		}
	});
	native.onPrompt = (text, admission) => {
		admission.disposition("started");
		native.emit({ type: "agent_start" });
		native.user("late-start", text);
		return work.promise;
	};
	runtime.submit("r", "handoff");
	await cancel;
	off();
	expect(aborts).toBeGreaterThanOrEqual(2);
	expect(native.hasActiveRun()).toBe(false);
	expect(store.request("r")?.status).toBe("interrupted");
});

test("a failed abort stays fenced until an explicit retry succeeds", async () => {
	const { native, runtime } = fixture();
	const work = Promise.withResolvers<void>();
	let first = true;
	native.onPrompt = (text, admission) => {
		native.emit({ type: "agent_start" });
		native.user("failed-abort", text);
		admission.disposition("started");
		return work.promise;
	};
	native.abort = async () => {
		if (first) {
			first = false;
			throw new Error("abort unavailable");
		}
		native.emit({ type: "agent_settled" });
		work.resolve();
	};
	runtime.submit("r", "work");
	await expect(runtime.cancel("r")).rejects.toThrow("abort unavailable");
	expect(runtime.isCancelling).toBe(true);
	expect(runtime.cancelRequestId()).toBe("r");
	expect(runtime.cancelFailed).toBe(true);
	expect(() => runtime.submit("next", "not yet")).toThrow();
	await runtime.cancel("r");
	expect(runtime.isCancelling).toBe(false);
	await expect(runtime.cancel("r")).rejects.toThrow();
});
