import { expect, test } from "bun:test";
import { DeliveryOwner } from "./delivery.ts";
import { AdoptionKernel } from "./kernel.ts";
import { KernelStore } from "./store.ts";
import type { Evidence, ModelPort, Purpose, ToolPort } from "./types.ts";

const purpose: Purpose = {
	id: "p",
	revision: 1,
	subject: "s",
	text: "answer",
	audience: "private",
	successCriteria: "reply",
	active: true,
	policyVersion: 1,
};
const evidence: Evidence = {
	id: "e",
	revision: 1,
	subject: "s",
	domain: "real",
	visibility: "private",
	text: "facts",
	active: true,
	sourceOwner: "owner",
	sourceId: "source",
	parents: [],
	participantRole: "performer",
	quality: { status: "unverified", verifier: null, detail: "new" },
};
function fixture(proposal: unknown) {
	const store = new KernelStore();
	store.setPurpose(purpose);
	store.observe("owner", evidence);
	const model: ModelPort = { propose: async () => proposal };
	return {
		store,
		kernel: new AdoptionKernel({
			store,
			model,
			tools: new Map(),
			delivery: new DeliveryOwner(),
		}),
	};
}
test("H01 rejects an unlisted tool without an effect", async () => {
	const { store, kernel } = fixture({
		kind: "tool",
		purposeRevision: 1,
		tool: "shell",
		args: {},
	});
	expect((await kernel.step("p")).status).toBe("rejected");
	expect(store.pending()).toEqual([]);
});
test("H05 rejects unknown proposal shape", async () => {
	const { kernel } = fixture({ kind: "escape", purposeRevision: 1 });
	expect((await kernel.step("p")).status).toBe("rejected");
});
test("ordinary answer is delivered", async () => {
	const { kernel } = fixture({
		kind: "answer",
		purposeRevision: 1,
		text: "hello",
	});
	expect((await kernel.step("p")).status).toBe("answered");
});
test("H04 rejects a purpose changed during a model call", async () => {
	const store = new KernelStore();
	store.setPurpose(purpose);
	store.observe("owner", evidence);
	const model: ModelPort = {
		propose: async () => {
			store.setPurpose({ ...purpose, revision: 2, text: "changed" });
			return { kind: "answer", purposeRevision: 1, text: "old" };
		},
	};
	const kernel = new AdoptionKernel({
		store,
		model,
		tools: new Map(),
		delivery: new DeliveryOwner(),
	});
	expect((await kernel.step("p")).status).toBe("rejected");
});
test("H10 rejects a supplied dependency corrected at the final fence", async () => {
	const store = new KernelStore();
	store.setPurpose(purpose);
	store.observe("owner", evidence);
	const kernel = new AdoptionKernel({
		store,
		model: {
			propose: async () => ({
				kind: "answer",
				purposeRevision: 1,
				text: "old",
			}),
		},
		tools: new Map(),
		delivery: new DeliveryOwner(),
		beforeAdmit: () =>
			store.correct("owner", { ...evidence, revision: 2, text: "new" }),
	});
	expect((await kernel.step("p")).status).toBe("rejected");
});
test("H02 excludes another subject's evidence from the frame", () => {
	const store = new KernelStore();
	store.setPurpose(purpose);
	store.observe("owner", evidence);
	store.observe("owner", {
		...evidence,
		id: "other",
		subject: "other-subject",
	});
	expect(store.frame("p").evidence.map((item) => item.id)).toEqual(["e"]);
});
test("H03 excludes private evidence from a public frame", () => {
	const store = new KernelStore();
	store.setPurpose({ ...purpose, audience: "public" });
	store.observe("owner", evidence);
	expect(store.frame("p").evidence).toEqual([]);
});
test("H06 invalidates an adopted plan after its evidence is retracted", async () => {
	const store = new KernelStore();
	store.setPurpose(purpose);
	store.observe("owner", evidence);
	const kernel = new AdoptionKernel({
		store,
		model: {
			propose: async () => ({
				kind: "adopt",
				purposeRevision: 1,
				adoptionKind: "plan",
				text: "plan",
				refs: [{ id: "e", revision: 1 }],
				condition: "when",
			}),
		},
		tools: new Map(),
		delivery: new DeliveryOwner(),
	});
	expect((await kernel.step("p")).status).toBe("adopted");
	expect(store.frame("p").adoptions).toHaveLength(1);
	store.retract("owner", { id: "e", revision: 2 });
	expect(store.frame("p").adoptions).toEqual([]);
});
test("H08 rejects an old correction and H09 deduplicates repeated notification", () => {
	const store = new KernelStore();
	store.observe("owner", evidence);
	store.observe("owner", evidence);
	store.correct("owner", { ...evidence, revision: 2, text: "new" });
	expect(() => store.correct("owner", evidence)).toThrow(
		"invalid evidence revision",
	);
});
test("H12 leaves a dispatched effect unknown when reconciliation has no receipt", async () => {
	const store = new KernelStore();
	store.setPurpose(purpose);
	store.observe("owner", evidence);
	const tool: ToolPort = {
		admit: () => {},
		result: async () => null,
		reconcile: async () => null,
	};
	const kernel = new AdoptionKernel({
		store,
		model: {
			propose: async () => ({
				kind: "tool",
				purposeRevision: 1,
				tool: "lookup",
				args: {},
			}),
		},
		tools: new Map([["lookup", tool]]),
		delivery: new DeliveryOwner(),
	});
	expect((await kernel.step("p")).status).toBe("unknown");
	expect(await kernel.resume()).toHaveLength(1);
});
test("H14 deferred work persists only until the matching signal", async () => {
	const { kernel } = fixture({
		kind: "defer",
		purposeRevision: 1,
		reason: "waiting",
		condition: "receipt",
	});
	expect((await kernel.step("p")).status).toBe("deferred");
});
test("H15 concurrent independent purposes reach separate model calls", async () => {
	const store = new KernelStore();
	store.setPurpose(purpose);
	store.setPurpose({ ...purpose, id: "p2", subject: "s2" });
	store.observe("owner", evidence);
	store.observe("owner", { ...evidence, id: "e2", subject: "s2" });
	let resolveFirst: (() => void) | undefined;
	const first = new Promise<void>((resolve) => {
		resolveFirst = resolve;
	});
	let calls = 0;
	const kernel = new AdoptionKernel({
		store,
		model: {
			propose: async () => {
				calls += 1;
				if (calls === 1) await first;
				return { kind: "noop", purposeRevision: 1, reason: "ok" };
			},
		},
		tools: new Map(),
		delivery: new DeliveryOwner(),
	});
	const pending = kernel.step("p");
	await Promise.resolve();
	const second = kernel.step("p2");
	await Promise.resolve();
	expect(calls).toBe(2);
	resolveFirst?.();
	await Promise.all([pending, second]);
});
test("new inactive revision suppresses its older active evidence", () => {
	const store = new KernelStore();
	store.setPurpose(purpose);
	store.observe("owner", evidence);
	store.retract("owner", { id: "e", revision: 2 });
	expect(store.frame("p").evidence).toEqual([]);
});
test("transitive adoption is excluded when its ancestor is withdrawn", async () => {
	const store = new KernelStore();
	store.setPurpose(purpose);
	store.observe("owner", evidence);
	const first = new AdoptionKernel({
		store,
		model: {
			propose: async () => ({
				kind: "adopt",
				purposeRevision: 1,
				adoptionKind: "understanding",
				text: "a",
				refs: [{ id: "e", revision: 1 }],
				condition: "c",
			}),
		},
		tools: new Map(),
		delivery: new DeliveryOwner(),
	});
	await first.step("p");
	const parent = store.frame("p").adoptions[0];
	if (!parent) throw Error("fixture");
	const second = new AdoptionKernel({
		store,
		model: {
			propose: async () => ({
				kind: "adopt",
				purposeRevision: 1,
				adoptionKind: "plan",
				text: "b",
				refs: [{ id: parent.id, revision: parent.revision }],
				condition: "c",
			}),
		},
		tools: new Map(),
		delivery: new DeliveryOwner(),
	});
	await second.step("p");
	store.retract("owner", { id: "e", revision: 2 });
	expect(store.frame("p").adoptions).toEqual([]);
});
test("completed receipts are projected into the next frame", async () => {
	const store = new KernelStore();
	store.setPurpose(purpose);
	store.observe("owner", evidence);
	const tool: ToolPort = {
		admit: () => {},
		result: async (effectId) => ({
			effectId,
			status: "completed",
			output: { ok: true },
			quality: { status: "pass", verifier: "v", detail: "ok" },
		}),
		reconcile: async () => null,
	};
	const kernel = new AdoptionKernel({
		store,
		model: {
			propose: async () => ({
				kind: "tool",
				purposeRevision: 1,
				tool: "lookup",
				args: {},
			}),
		},
		tools: new Map([["lookup", tool]]),
		delivery: new DeliveryOwner(),
	});
	await kernel.step("p");
	expect(store.frame("p").receipts).toHaveLength(1);
});
test("defer survives then resumes only on its matching signal", async () => {
	const { store, kernel } = fixture({
		kind: "defer",
		purposeRevision: 1,
		reason: "waiting",
		condition: "receipt",
	});
	await kernel.step("p");
	store.signal("other");
	expect(
		(await kernel.resume()).some((trace) => trace.status === "deferred"),
	).toBe(true);
	store.signal("receipt");
	expect(
		(await kernel.resume()).some((trace) => trace.status === "deferred"),
	).toBe(false);
});
test("tool result persists after admission", async () => {
	const receipt = {
		effectId: "",
		status: "completed" as const,
		output: { ok: true },
		quality: { status: "unverified" as const, verifier: null, detail: "done" },
	};
	const tool: ToolPort = {
		admit: () => {},
		result: async (id) => ({ ...receipt, effectId: id }),
		reconcile: async () => null,
	};
	const store = new KernelStore();
	store.setPurpose(purpose);
	store.observe("owner", evidence);
	const kernel = new AdoptionKernel({
		store,
		model: {
			propose: async () => ({
				kind: "tool",
				purposeRevision: 1,
				tool: "lookup",
				args: {},
			}),
		},
		tools: new Map([["lookup", tool]]),
		delivery: new DeliveryOwner(),
	});
	expect((await kernel.step("p")).status).toBe("dispatched");
	expect(store.pending()).toEqual([]);
});

test("restored unknown evidence domain is rejected instead of reaching model frame", () => {
	const store = new KernelStore();
	try {
		store.setPurpose(purpose);
		store.observe("owner", evidence);
		store.db
			.prepare(
				"UPDATE kernel_rows SET data=json_set(data,'$.domain','invalid-domain') WHERE kind='evidence'",
			)
			.run();
		expect(() => store.frame("p")).toThrow();
	} finally {
		store.close();
	}
});
test("restored purpose revision must match its database row identity", () => {
	const store = new KernelStore();
	try {
		store.setPurpose(purpose);
		store.db
			.prepare(
				"UPDATE kernel_rows SET data=json_set(data,'$.revision',99) WHERE kind='purpose'",
			)
			.run();
		expect(() => store.frame("p")).toThrow();
	} finally {
		store.close();
	}
});

test("private tool receipt never enters another subject or public frame", async () => {
	const store = new KernelStore();
	const delivery = new DeliveryOwner();
	try {
		store.setPurpose(purpose);
		store.observe("owner", evidence);
		const tool: ToolPort = {
			admit: () => {},
			result: async (id) => ({
				effectId: id,
				status: "completed",
				output: "PRIVATE_RECEIPT_CANARY",
				quality: { status: "unverified", verifier: null, detail: "result" },
			}),
			reconcile: async () => null,
		};
		await new AdoptionKernel({
			store,
			delivery,
			tools: new Map([["lookup", tool]]),
			model: {
				propose: async () => ({
					kind: "tool",
					purposeRevision: 1,
					tool: "lookup",
					args: {},
				}),
			},
		}).step("p");
		expect(JSON.stringify(store.frame("p"))).toContain(
			"PRIVATE_RECEIPT_CANARY",
		);
		store.setPurpose({ ...purpose, id: "other", subject: "other" });
		expect(JSON.stringify(store.frame("other"))).not.toContain(
			"PRIVATE_RECEIPT_CANARY",
		);
		store.setPurpose({ ...purpose, revision: 2, audience: "public" });
		expect(JSON.stringify(store.frame("p"))).not.toContain(
			"PRIVATE_RECEIPT_CANARY",
		);
	} finally {
		store.close();
		delivery.close();
	}
});
