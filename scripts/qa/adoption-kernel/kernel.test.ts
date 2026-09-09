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
	const original = await kernel.step("p");
	store.signal("other");
	expect(
		(await kernel.resume()).some((trace) => trace.status === "deferred"),
	).toBe(true);
	store.signal("receipt");
	const resumed = await kernel.resume();
	expect(resumed).toHaveLength(1);
	expect(resumed[0]?.status).toBe("deferred");
	expect(resumed[0]?.decisionId).not.toBe(original.decisionId);
	expect(store.deferred()).not.toContain(original.decisionId);
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

test("resume reconciles original tool receipt without another admission or model call", async () => {
	const store = new KernelStore();
	const delivery = new DeliveryOwner();
	let admissions = 0,
		models = 0;
	let completed = false;
	const tool: ToolPort = {
		admit: () => {
			admissions++;
		},
		result: async () => null,
		reconcile: async (id) =>
			completed
				? {
						effectId: id,
						status: "completed",
						output: "recovered",
						quality: {
							status: "unverified",
							verifier: null,
							detail: "owner receipt",
						},
					}
				: null,
	};
	try {
		store.setPurpose(purpose);
		const kernel = new AdoptionKernel({
			store,
			delivery,
			tools: new Map([["lookup", tool]]),
			model: {
				propose: async () => {
					models++;
					return { kind: "tool", purposeRevision: 1, tool: "lookup", args: {} };
				},
			},
		});
		expect((await kernel.step("p")).status).toBe("unknown");
		expect((await kernel.resume())[0]?.status).toBe("unknown");
		completed = true;
		expect((await kernel.resume())[0]?.status).toBe("dispatched");
		expect(store.frame("p").receipts[0]?.output).toBe("recovered");
		expect(await kernel.resume()).toEqual([]);
		expect(admissions).toBe(1);
		expect(models).toBe(1);
	} finally {
		store.close();
		delivery.close();
	}
});

test("explicit unknown receipt remains reconcilable", async () => {
	const store = new KernelStore();
	const delivery = new DeliveryOwner();
	let resolve = false;
	const tool: ToolPort = {
		admit: () => {},
		result: async (id) => ({
			effectId: id,
			status: "unknown",
			output: null,
			quality: { status: "unverified", verifier: null, detail: "unknown" },
		}),
		reconcile: async (id) =>
			resolve
				? {
						effectId: id,
						status: "completed",
						output: "resolved",
						quality: {
							status: "unverified",
							verifier: null,
							detail: "receipt",
						},
					}
				: null,
	};
	try {
		store.setPurpose(purpose);
		const kernel = new AdoptionKernel({
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
		});
		expect((await kernel.step("p")).status).toBe("unknown");
		expect(store.pending()).toHaveLength(1);
		resolve = true;
		expect((await kernel.resume())[0]?.status).toBe("dispatched");
		expect(store.pending()).toEqual([]);
	} finally {
		store.close();
		delivery.close();
	}
});

test("invalid runtime receipt cannot become trusted input", async () => {
	const store = new KernelStore();
	const delivery = new DeliveryOwner();
	const tool: ToolPort = {
		admit: () => {},
		result: async (id) =>
			JSON.parse(
				JSON.stringify({
					effectId: id,
					status: "completed",
					output: "bad",
					quality: { status: "invented", verifier: null, detail: "invalid" },
				}),
			),
		reconcile: async () => null,
	};
	try {
		store.setPurpose(purpose);
		const kernel = new AdoptionKernel({
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
		});
		await expect(kernel.step("p")).rejects.toThrow();
		expect(store.frame("p").receipts).toEqual([]);
		expect(store.pending()).toHaveLength(1);
	} finally {
		store.close();
		delivery.close();
	}
});

test("adoption preserves the original decision snapshot", async () => {
	const { store, kernel } = fixture({
		kind: "adopt",
		purposeRevision: 1,
		adoptionKind: "plan",
		text: "check first",
		refs: [{ id: "e", revision: 1 }],
		condition: "before work",
	});
	try {
		const result = await kernel.step("p");
		const row = store.db
			.prepare("SELECT data FROM kernel_decisions WHERE id=?")
			.get(result.decisionId);
		const value = JSON.parse(String(row?.["data"]));
		expect(value.frame.purpose).toEqual(purpose);
		expect(value.frame.evidence).toEqual([evidence]);
		expect(value.status).toBe("adopted");
		expect(value.expectation).toEqual({ kind: "none" });
		expect(value.policyVersion).toBe(purpose.policyVersion);
		expect(value.method).toBeNull();
	} finally {
		store.close();
	}
});

test("derived evidence inherits ancestor withdrawal and privacy", () => {
	const store = new KernelStore();
	try {
		store.setPurpose(purpose);
		store.observe("owner", evidence);
		store.observe("owner", {
			...evidence,
			id: "derived",
			sourceId: "derived-source",
			visibility: "public",
			text: "derived secret",
			parents: [{ id: "e", revision: 1 }],
		});
		expect(store.frame("p").evidence.map((x) => x.id)).toContain("derived");
		store.setPurpose({ ...purpose, id: "public", audience: "public" });
		expect(store.frame("public").evidence).toEqual([]);
		store.retract("owner", { id: "e", revision: 2 });
		expect(store.frame("p").evidence).toEqual([]);
	} finally {
		store.close();
	}
});

test("explicit pre-action judgment survives adoption and cannot be rewritten afterward", async () => {
	const { store, kernel } = fixture({
		kind: "adopt",
		purposeRevision: 1,
		adoptionKind: "plan",
		text: "compare",
		refs: [{ id: "e", revision: 1 }],
		condition: "current request",
		judgment: {
			method: "compare original rows",
			expectation: { kind: "stated", text: "rows will agree" },
		},
	});
	try {
		const result = await kernel.step("p");
		expect(result.status).toBe("adopted");
		const row = store.db
			.prepare("SELECT data FROM kernel_decisions WHERE id=?")
			.get(result.decisionId);
		const value = JSON.parse(String(row?.["data"]));
		expect(value.method).toBe("compare original rows");
		expect(value.expectation).toEqual({
			kind: "stated",
			text: "rows will agree",
		});
		expect(() =>
			store.recordJudgment(result.decisionId, {
				method: "changed",
				expectation: { kind: "none" },
			}),
		).toThrow();
	} finally {
		store.close();
	}
});

test("answer receipt is tracked and recovered after owner admission interruption", async () => {
	const store = new KernelStore();
	const owner = new DeliveryOwner();
	let fail = true;
	let admissions = 0;
	const delivery = {
		admit: (
			id: string,
			bytes: string,
			audience: "private" | "public",
			fence: string,
		) => {
			admissions++;
			owner.admit(id, bytes, audience, fence);
			if (fail) throw Error("after owner commit");
		},
		reconcile: (id: string) => owner.reconcile(id),
	};
	try {
		store.setPurpose(purpose);
		const kernel = new AdoptionKernel({
			store,
			delivery,
			tools: new Map(),
			model: {
				propose: async () => ({
					kind: "answer",
					purposeRevision: 1,
					text: "hello",
				}),
			},
		});
		await expect(kernel.step("p")).rejects.toThrow("after owner commit");
		expect(store.pending()).toHaveLength(1);
		fail = false;
		expect((await kernel.resume())[0]?.status).toBe("answered");
		expect(store.pending()).toEqual([]);
		expect(admissions).toBe(1);
	} finally {
		store.close();
		owner.close();
	}
});

test("matching deferred signal actually runs a new judgment once", async () => {
	const store = new KernelStore();
	const delivery = new DeliveryOwner();
	let calls = 0;
	try {
		store.setPurpose(purpose);
		const kernel = new AdoptionKernel({
			store,
			delivery,
			tools: new Map(),
			model: {
				propose: async () =>
					++calls === 1
						? {
								kind: "defer",
								purposeRevision: 1,
								reason: "waiting",
								condition: "ready",
							}
						: { kind: "answer", purposeRevision: 2, text: "new purpose" },
			},
		});
		expect((await kernel.step("p")).status).toBe("deferred");
		store.signal("other");
		await kernel.resume();
		expect(calls).toBe(1);
		store.setPurpose({ ...purpose, revision: 2, text: "updated" });
		store.signal("ready");
		expect((await kernel.resume())[0]?.status).toBe("answered");
		expect(calls).toBe(2);
		expect(await kernel.resume()).toEqual([]);
		expect(calls).toBe(2);
	} finally {
		store.close();
		delivery.close();
	}
});

test("another SQLite writer cannot change evidence inside final owner admission", async () => {
	const { mkdtempSync, rmSync } = await import("node:fs");
	const { join } = await import("node:path");
	const { tmpdir } = await import("node:os");
	const root = mkdtempSync(join(tmpdir(), "admission-fence-"));
	const path = join(root, "state.sqlite");
	const first = new KernelStore(path);
	const second = new KernelStore(path);
	let blocked = false;
	try {
		first.setPurpose(purpose);
		first.observe("owner", evidence);
		const kernel = new AdoptionKernel({
			store: first,
			tools: new Map(),
			delivery: {
				admit: () => {
					try {
						second.correct("owner", {
							...evidence,
							revision: 2,
							text: "changed",
						});
					} catch {
						blocked = true;
					}
				},
				reconcile: async (id) => ({
					effectId: id,
					status: "completed",
					output: "delivered",
					quality: { status: "unverified", verifier: null, detail: "delivery" },
				}),
			},
			model: {
				propose: async () => ({
					kind: "answer",
					purposeRevision: 1,
					text: "answer",
				}),
			},
		});
		expect((await kernel.step("p")).status).toBe("answered");
		expect(blocked).toBe(true);
		second.correct("owner", { ...evidence, revision: 2, text: "changed" });
		expect(first.frame("p").evidence[0]?.revision).toBe(2);
	} finally {
		first.close();
		second.close();
		rmSync(root, { recursive: true, force: true });
	}
});

test("durable request reservation excludes concurrent judgment and replays result", async () => {
	const store = new KernelStore();
	const delivery = new DeliveryOwner();
	let calls = 0;
	let release!: () => void;
	const gate = new Promise<void>((r) => {
		release = r;
	});
	let entered!: () => void;
	const started = new Promise<void>((r) => {
		entered = r;
	});
	const options = {
		store,
		delivery,
		tools: new Map<string, ToolPort>(),
		model: {
			propose: async () => {
				calls++;
				entered();
				await gate;
				return { kind: "answer", purposeRevision: 1, text: "once" };
			},
		},
	};
	try {
		store.setPurpose(purpose);
		const first = new AdoptionKernel(options);
		const second = new AdoptionKernel(options);
		const pending = first.step("p", "request-one");
		await started;
		const duplicate = second.step("p", "request-two");
		release();
		const blocked = await duplicate;
		const done = await pending;
		expect(blocked.status).toBe("unknown");
		expect(calls).toBe(1);
		expect(done.status).toBe("answered");
		expect(await second.step("p", "request-one")).toEqual(done);
		expect(calls).toBe(1);
	} finally {
		release();
		store.close();
		delivery.close();
	}
});

test("request result replay survives closing kernel storage", async () => {
	const { mkdtempSync, rmSync } = await import("node:fs");
	const { join } = await import("node:path");
	const { tmpdir } = await import("node:os");
	const root = mkdtempSync(join(tmpdir(), "request-replay-"));
	const path = join(root, "kernel.sqlite");
	const owner = new DeliveryOwner(join(root, "delivery.sqlite"));
	let calls = 0;
	const model = {
		propose: async () => {
			calls++;
			return { kind: "answer", purposeRevision: 1, text: "stored" };
		},
	};
	try {
		const first = new KernelStore(path);
		first.setPurpose(purpose);
		const result = await new AdoptionKernel({
			store: first,
			delivery: owner,
			tools: new Map(),
			model,
		}).step("p", "stable-request");
		first.close();
		const second = new KernelStore(path);
		try {
			expect(
				await new AdoptionKernel({
					store: second,
					delivery: owner,
					tools: new Map(),
					model,
				}).step("p", "stable-request"),
			).toEqual(result);
			expect(calls).toBe(1);
		} finally {
			second.close();
		}
	} finally {
		owner.close();
		rmSync(root, { recursive: true, force: true });
	}
});

test("model cannot rewrite the admission snapshot to hide a correction", async () => {
	const store = new KernelStore();
	const delivery = new DeliveryOwner();
	store.setPurpose(purpose);
	store.observe("owner", evidence);
	try {
		const kernel = new AdoptionKernel({
			store,
			delivery,
			tools: new Map(),
			model: {
				propose: async (frame) => {
					store.observe("owner", {
						...evidence,
						revision: 2,
						text: "corrected",
					});
					frame.evidence = store.frame("p").evidence;
					return { kind: "answer", purposeRevision: 1, text: "stale judgment" };
				},
			},
		});
		expect((await kernel.step("p")).status).toBe("rejected");
	} finally {
		store.close();
		delivery.close();
	}
});

test("deferred wake replays its judgment after interruption before linking", async () => {
	const store = new KernelStore();
	const delivery = new DeliveryOwner();
	store.setPurpose(purpose);
	let calls = 0;
	const kernel = new AdoptionKernel({
		store,
		delivery,
		tools: new Map(),
		model: {
			propose: async () =>
				++calls === 1
					? {
							kind: "defer",
							purposeRevision: 1,
							reason: "waiting",
							condition: "ready",
						}
					: { kind: "answer", purposeRevision: 1, text: "once" },
		},
	});
	try {
		await kernel.step("p");
		store.signal("ready");
		const complete = store.completeDeferred.bind(store);
		store.completeDeferred = () => {
			throw Error("crash before link");
		};
		await expect(kernel.resume()).rejects.toThrow("crash before link");
		store.completeDeferred = complete;
		const resumed = await Promise.all([kernel.resume(), kernel.resume()]);
		expect(resumed[0]?.[0]?.status).toBe("answered");
		expect(calls).toBe(2);
		expect(await kernel.resume()).toEqual([]);
	} finally {
		store.close();
		delivery.close();
	}
});

test("invalid source writes are rejected without poisoning the next frame", () => {
	const store = new KernelStore();
	try {
		store.setPurpose(purpose);
		const invalid = { ...evidence, revision: -1 };
		expect(() => store.observe("owner", invalid)).toThrow();
		expect(store.frame("p").evidence).toEqual([]);
	} finally {
		store.close();
	}
});

test("withdrawn adoption revision suppresses the older active judgment", async () => {
	const { store, kernel } = fixture({
		kind: "adopt",
		purposeRevision: 1,
		adoptionKind: "plan",
		text: "plan",
		refs: [{ id: "e", revision: 1 }],
		condition: "always",
	});
	try {
		await kernel.step("p");
		const adopted = store.frame("p").adoptions[0];
		expect(adopted).toBeDefined();
		if (!adopted) throw Error("missing adoption");
		const withdrawn = { ...adopted, revision: 2, status: "withdrawn" };
		store.db
			.prepare("INSERT INTO kernel_rows VALUES ('adoption',?,?,?)")
			.run(adopted.id, 2, JSON.stringify(withdrawn));
		expect(store.frame("p").adoptions).toEqual([]);
	} finally {
		store.close();
	}
});

test("private purpose text cannot become a public adoption without evidence refs", async () => {
	const store = new KernelStore();
	const delivery = new DeliveryOwner();
	store.setPurpose({ ...purpose, text: "private canary" });
	try {
		const kernel = new AdoptionKernel({
			store,
			delivery,
			tools: new Map(),
			model: {
				propose: async () => ({
					kind: "adopt",
					purposeRevision: 1,
					adoptionKind: "understanding",
					text: "private canary",
					refs: [],
					condition: "always",
				}),
			},
		});
		expect((await kernel.step("p")).status).toBe("adopted");
		store.setPurpose({
			...purpose,
			revision: 2,
			audience: "public",
			text: "public task",
		});
		expect(store.frame("p").adoptions).toEqual([]);
	} finally {
		store.close();
		delivery.close();
	}
});
