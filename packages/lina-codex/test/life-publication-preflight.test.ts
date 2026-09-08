import { afterEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type {
	LifeModelRequest,
	PreparedLifeModelRequest,
} from "../../lina-core/src/world/autonomy-types.ts";
import { lifeDigest } from "../../lina-core/src/world/life-json.ts";
import { createCodexLifeModel } from "../src/life-model.ts";
import { LifeModelJournal } from "../src/life-model-journal.ts";
import { lifePlan } from "../src/life-model-policy.ts";
import { lifeReference } from "../src/life-model-validation.ts";
import { lifeFixture, lifeRequest } from "./life-model-fixture.ts";

const nativeTest =
	process.env["LINA_LIFE_NATIVE_TEST"] === "1" ? test : test.skip;
const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => {
	for (const close of cleanup.splice(0).reverse()) await close();
});
const signal = () => new AbortController().signal;
const failed = {
	status: "failed",
	upstreamAttempts: 0,
	usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
	reason: "LIFE native request failed",
} as const;
function requestFor(version: 1 | 2): LifeModelRequest {
	const request = lifeRequest();
	if (version === 1) return request;
	const { stepId: _stepId, ...common } = request;
	return {
		...common,
		version: 2,
		lane: "publication",
		jobId: "publication-job",
	};
}
function fixture() {
	const f = lifeFixture();
	cleanup.push(() => f.close());
	return f;
}
function model(options: Parameters<typeof createCodexLifeModel>[0]) {
	const port = createCodexLifeModel(options);
	cleanup.push(() => port.close());
	return port;
}
function saved(
	root: string,
	request = requestFor(2),
	fingerprint = "a".repeat(64),
) {
	const prepared: PreparedLifeModelRequest = {
		version: 1,
		request,
		inputDigest: lifeDigest(request),
		capabilityFingerprint: fingerprint,
		nativeReference: lifeReference(request),
	};
	const journal = new LifeModelJournal(root, prepared, true);
	return { prepared, journal };
}

for (const version of [1, 2] as const) {
	nativeTest(
		`v${version} missing complete credential is durably failed0; restoring it requires a new native attempt`,
		async () => {
			const f = fixture();
			let credential = false;
			const callbacks: LifeModelRequest[] = [];
			const options = {
				...f.options,
				providerEnv: () => (credential ? f.options.providerEnv() : {}),
				beforeOutbound(request: LifeModelRequest) {
					callbacks.push(request);
				},
			};
			const port = model(options);
			const request = requestFor(version);
			const prepared = await port.prepare(request, signal());
			expect(await port.reconcile(prepared)).toEqual({
				status: "not_dispatched",
			});
			await expect(port.complete(prepared, signal())).rejects.toThrow();
			expect(f.captures).toHaveLength(0);
			expect(callbacks).toHaveLength(0);
			expect(await port.reconcile(prepared)).toEqual(failed);
			const journal = new LifeModelJournal(f.root, prepared);
			expect(journal.has("dispatch")).toBe(false);
			expect(journal.has("outbound")).toBe(false);
			expect(
				JSON.parse(
					readFileSync(join(journal.directory, "failure.json"), "utf8"),
				),
			).toMatchObject(failed);
			await port.close();
			credential = true;
			const reopened = model(options);
			expect(await reopened.reconcile(prepared)).toEqual(failed);
			await expect(reopened.complete(prepared, signal())).rejects.toThrow(
				"no inference retry",
			);
			expect(await reopened.prepare(request, signal())).toEqual(prepared);
			await expect(reopened.complete(prepared, signal())).rejects.toThrow(
				"no inference retry",
			);
			expect(f.captures).toHaveLength(0);
			expect(callbacks).toHaveLength(0);
			const next = await reopened.prepare(
				{ ...request, id: randomUUID() },
				signal(),
			);
			expect(next.nativeReference).not.toBe(prepared.nativeReference);
			const result = await reopened.complete(next, signal());
			expect(result.usage).toEqual({
				inputTokens: 31,
				outputTokens: 7,
				totalTokens: 38,
			});
			expect(await reopened.complete(next, signal())).toEqual(result);
			expect(callbacks).toEqual([next.request]);
			expect(f.captures).toHaveLength(1);
		},
		60000,
	);

	for (const denial of ["selection", "abort"] as const) {
		test(`v${version} ${denial} before native dispatch persists exact failed0 across reopen`, async () => {
			const f = fixture();
			const { prepared, journal } = saved(f.root, requestFor(version));
			let selections = 0;
			const options = {
				...f.options,
				selection() {
					selections++;
					throw Error("Synthetic current source denial");
				},
			};
			const port = model(options);
			const controller = new AbortController();
			if (denial === "abort") controller.abort();
			await expect(
				port.complete(prepared, controller.signal),
			).rejects.toThrow();
			expect(await port.reconcile(prepared)).toEqual(failed);
			expect(journal.has("dispatch")).toBe(false);
			expect(selections).toBe(denial === "abort" ? 0 : 1);
			await port.close();
			const reopened = model(options);
			expect(await reopened.reconcile(prepared)).toEqual(failed);
			await expect(reopened.complete(prepared, signal())).rejects.toThrow(
				"no inference retry",
			);
			expect(f.captures).toHaveLength(0);
		});
	}
}

nativeTest(
	"early assertCurrent and qualification denial retain failed0 after reopening",
	async () => {
		const f = fixture();
		for (const denial of ["fingerprint", "qualification"] as const) {
			// An ELF that always fails is an explicit local qualification negative.
			const base =
				denial === "qualification"
					? { ...f.options, wrapperCommand: "/usr/bin/false" }
					: f.options;
			const request = requestFor(2);
			const { prepared } = saved(
				f.root,
				request,
				lifePlan(base, request).fingerprint,
			);
			let checks = 0;
			const port = model({
				...base,
				selection() {
					checks++;
					return denial === "fingerprint" && checks === 2
						? {
								...f.selection,
								selected: { ...f.selection.selected, id: "changed-profile" },
							}
						: f.selection;
				},
			});
			await expect(port.complete(prepared, signal())).rejects.toThrow();
			expect(await port.reconcile(prepared)).toEqual(failed);
			await port.close();
			const reopened = model(base);
			expect(await reopened.reconcile(prepared)).toEqual(failed);
			await expect(reopened.complete(prepared, signal())).rejects.toThrow(
				"no inference retry",
			);
		}
		expect(f.captures).toHaveLength(0);
	},
	60000,
);

for (const corruption of [
	"absent",
	"initial",
	"foreign",
	"unexpected",
	"outbound",
	"preflight",
] as const) {
	test(`${corruption} journal never becomes zero-cost failure on preflight denial`, async () => {
		const f = fixture();
		const { prepared, journal } = saved(f.root);
		const initial = join(journal.directory, "initial.json");
		if (corruption === "absent") unlinkSync(initial);
		if (corruption === "initial") writeFileSync(initial, "{");
		if (corruption === "foreign")
			writeFileSync(
				initial,
				JSON.stringify({ ...prepared, capabilityFingerprint: "b".repeat(64) }),
			);
		if (corruption === "unexpected")
			journal.write("unexpected", { status: "unknown" });
		if (corruption === "outbound")
			journal.write("outbound", {
				version: 1,
				requestId: "foreign",
				inputDigest: prepared.inputDigest,
				upstreamAttempts: 1,
			});
		if (corruption === "preflight")
			journal.write("preflight", {
				version: 1,
				requestId: "foreign",
				inputDigest: prepared.inputDigest,
				pid: process.pid,
			});
		const port = model({
			...f.options,
			selection() {
				throw Error("Source denied");
			},
		});
		await expect(port.complete(prepared, signal())).rejects.toThrow();
		await expect(port.reconcile(prepared)).rejects.toThrow();
		expect(existsSync(join(journal.directory, "failure.json"))).toBe(false);
		expect(f.captures).toHaveLength(0);
	});
}

test("old v1 dispatch/failure records retain their exact unknown usage", async () => {
	const f = fixture();
	const { prepared, journal } = saved(f.root, requestFor(1));
	journal.write("dispatch", {
		version: 1,
		requestId: prepared.request.id,
		inputDigest: prepared.inputDigest,
		pid: process.pid,
	});
	const legacy = {
		...failed,
		usage: { inputTokens: null, outputTokens: null, totalTokens: null },
	};
	journal.write("failure", legacy);
	const port = model(f.options);
	expect(await port.reconcile(prepared)).toEqual(legacy);
	await expect(port.complete(prepared, signal())).rejects.toThrow(
		"no inference retry",
	);
	expect(f.captures).toHaveLength(0);
});

for (const marker of ["preflight", "dispatch"] as const) {
	test(`interrupted ${marker} remains unknown across reopen and cannot run again`, async () => {
		const f = fixture();
		const { prepared, journal } = saved(f.root);
		journal.write(marker, {
			version: 1,
			requestId: prepared.request.id,
			inputDigest: prepared.inputDigest,
			pid: process.pid,
		});
		const unknown = {
			status: "unknown",
			upstreamAttempts: 0,
			usage: { inputTokens: null, outputTokens: null, totalTokens: null },
		} as const;
		const port = model(f.options);
		expect(await port.reconcile(prepared)).toEqual(unknown);
		await port.close();
		const reopened = model(f.options);
		await expect(reopened.complete(prepared, signal())).rejects.toThrow(
			"no inference retry",
		);
		expect(await reopened.reconcile(prepared)).toEqual(unknown);
		expect(journal.has("failure")).toBe(false);
		expect(f.captures).toHaveLength(0);
	});
}

test("preflight failure requires a valid claim and exact zero usage", async () => {
	const f = fixture();
	for (const invalid of ["orphan", "unknown-usage", "foreign-claim"] as const) {
		const { prepared, journal } = saved(f.root);
		if (invalid !== "orphan")
			journal.write("preflight", {
				version: 1,
				requestId:
					invalid === "foreign-claim" ? "foreign" : prepared.request.id,
				inputDigest: prepared.inputDigest,
				pid: process.pid,
			});
		journal.write(
			"failure",
			invalid === "unknown-usage"
				? {
						...failed,
						usage: { inputTokens: null, outputTokens: null, totalTokens: null },
					}
				: failed,
		);
		const reopened = model(f.options);
		await expect(reopened.reconcile(prepared)).rejects.toThrow();
		await expect(reopened.complete(prepared, signal())).rejects.toThrow();
	}
	expect(f.captures).toHaveLength(0);
});

test("journal corrupted during a local selection check cannot be replaced with failed0", async () => {
	const f = fixture();
	const { prepared, journal } = saved(f.root);
	const port = model({
		...f.options,
		selection() {
			writeFileSync(join(journal.directory, "initial.json"), "{");
			throw Error("Source denied after storage corruption");
		},
	});
	await expect(port.complete(prepared, signal())).rejects.toThrow();
	await expect(port.reconcile(prepared)).rejects.toThrow();
	expect(journal.has("failure")).toBe(false);
	expect(f.captures).toHaveLength(0);
});

nativeTest(
	"aborting from the v1 final outbound callback stays durably failed0",
	async () => {
		const f = fixture();
		const controller = new AbortController();
		const checked: LifeModelRequest[] = [];
		const port = model({
			...f.options,
			beforeOutbound(request) {
				checked.push(request);
				controller.abort();
			},
		});
		const prepared = await port.prepare(requestFor(1), signal());
		await expect(port.complete(prepared, controller.signal)).rejects.toThrow();
		expect(checked).toEqual([prepared.request]);
		expect(await port.reconcile(prepared)).toEqual(failed);
		await port.close();
		const reopened = model(f.options);
		expect(await reopened.reconcile(prepared)).toEqual(failed);
		await expect(reopened.complete(prepared, signal())).rejects.toThrow(
			"no inference retry",
		);
		expect(f.captures).toHaveLength(0);
	},
	60000,
);
