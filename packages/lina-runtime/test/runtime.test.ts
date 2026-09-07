import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DurableStore } from "../../lina-core/src/index.ts";
import { DurableRuntime } from "../src/runtime.ts";
import { ControlledSession } from "./runtime-fixture.ts";

const cleanups: (() => void)[] = [];
afterEach(() => {
	for (const close of cleanups.splice(0).reverse()) close();
});
function setup() {
	const root = mkdtempSync(join(tmpdir(), "lina-runtime-test-"));
	cleanups.push(() => rmSync(root, { recursive: true, force: true }));
	const native = new ControlledSession();
	const binding = {
		version: 1 as const,
		botId: "lina",
		sessionId: native.sessionId,
		sessionFile: native.sessionFile,
		workspace: root,
	};
	const store = new DurableStore(join(root, "app.sqlite"), binding);
	cleanups.push(() => store.close());
	const runtime = new DurableRuntime(native, store, binding);
	cleanups.push(() => runtime.detach());
	return { native, store, runtime };
}

function until(
	runtime: DurableRuntime,
	condition: () => boolean,
): Promise<void> {
	if (condition()) return Promise.resolve();
	return new Promise((resolve) => {
		const off = runtime.subscribe(() => {
			if (condition()) {
				off();
				resolve();
			}
		});
	});
}

test("submission is durable before dispatch and duplicate IDs run once", async () => {
	const { native, store, runtime } = setup();
	native.onPrompt = async (text, admission) => {
		expect(store.request("r1")?.text).toBe(text);
		native.user("native1", text); // deliberately before disposition callback
		admission.disposition("started");
	};
	runtime.submit("r1", "same text");
	runtime.submit("r1", "same text");
	expect(() => runtime.submit("r1", "different text")).toThrow();
	await until(runtime, () => store.request("r1")?.entryId === "native1");
	expect(native.calls).toEqual(["same text"]);
	expect(runtime.snapshot().messages.map((message) => message.entryId)).toEqual(
		["native1"],
	);
});

test("distinct IDs with identical content correlate by dispatched order", async () => {
	const { native, store, runtime } = setup();
	let index = 0;
	native.onPrompt = async (text, admission) => {
		native.user(`entry${++index}`, text);
		admission.disposition("queued");
	};
	runtime.submit("r1", "same");
	runtime.submit("r2", "same");
	await until(runtime, () => store.request("r2")?.entryId === "entry2");
	expect(store.request("r1")?.entryId).toBe("entry1");
	expect(native.calls).toHaveLength(2);
});

test("queued prompt completion and agent_end cannot mark requests settled", async () => {
	const { native, store, runtime } = setup();
	native.onPrompt = async (_text, admission) => {
		admission.disposition("queued");
	};
	runtime.submit("queued", "Waiting");
	await until(runtime, () => store.request("queued")?.status === "accepted");
	native.emit({ type: "agent_end", willRetry: false });
	expect(store.request("queued")?.status).toBe("accepted");
	native.emit({ type: "agent_settled" });
	await until(runtime, () => store.request("queued")?.status === "interrupted");
	expect(native.clears).toBe(1);
});

test("terminal failure clears B before C can admit or consume old native work", async () => {
	const { native, store, runtime } = setup();
	native.onPrompt = async (text, admission) => {
		if (text === "B") {
			native.queued.push(text);
			admission.disposition("queued");
			return;
		}
		for (const queued of native.queued.splice(0))
			native.user(`late-${queued}`, queued);
		native.user(`entry-${text}`, text);
		admission.disposition("started");
	};
	runtime.submit("a", "A");
	runtime.submit("b", "B");
	await until(runtime, () => store.request("b")?.status === "accepted");
	native.emit({
		type: "message_end",
		message: {
			role: "assistant",
			stopReason: "error",
			errorMessage: "offline",
		},
	});
	native.emit({ type: "agent_settled" });
	runtime.submit("c", "C");
	await until(runtime, () => store.request("c")?.entryId === "entry-C");
	expect(store.request("b")?.status).toBe("interrupted");
	expect(store.entry("late-B")).toBeUndefined();
	expect(store.request("a")?.status).toBe("interrupted");
});

test("settlement aborts in-flight preflight before allowing the next request", async () => {
	const { native, store, runtime } = setup();
	const waiting = Promise.withResolvers<void>();
	let aborted = false;
	native.onPrompt = (text, admission) => {
		if (text === "C") {
			expect(aborted).toBe(true);
			native.user("c-entry", text);
			admission.disposition("started");
			return Promise.resolve();
		}
		waiting.resolve();
		return new Promise((_resolve, reject) =>
			admission.signal.addEventListener(
				"abort",
				() => {
					aborted = true;
					reject(new Error("preflight cancelled"));
				},
				{ once: true },
			),
		);
	};
	runtime.submit("b", "B");
	await waiting.promise;
	native.emit({ type: "agent_settled" });
	runtime.submit("c", "C");
	await until(runtime, () => store.request("c")?.entryId === "c-entry");
	expect(store.request("b")?.status).toBe("interrupted");
});

test("a successful native retry does not retain the previous attempt's provider error", async () => {
	const { native, store, runtime } = setup();
	native.onPrompt = async (text, admission) => {
		native.user("retry-entry", text);
		admission.disposition("started");
	};
	runtime.submit("retry", "Try once");
	await until(runtime, () => store.request("retry")?.entryId === "retry-entry");
	native.emit({
		type: "message_end",
		message: {
			role: "assistant",
			stopReason: "error",
			errorMessage: "temporary",
		},
	});
	native.emit({ type: "agent_end", willRetry: true });
	native.emit({ type: "agent_start" });
	native.emit({ type: "agent_settled" });
	await until(runtime, () => store.request("retry")?.status !== "accepted");
	expect(store.request("retry")?.status).toBe("settled");
});
