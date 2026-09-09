import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { accountingFixture } from "./life-image-accounting-fixture.test.ts";

// Source-layer proof of the transaction/fetch handoff; the runtime client wiring is main-owned.
test("final synchronous hook commits original dispatch before actual loopback POST; HTTP 503 cannot refund", async () => {
	const f = accountingFixture();
	const input = f.input();
	const observer = f.connect();
	let calls = 0;
	const observedDispatch: Array<number | null> = [];
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch(request) {
			if (request.method !== "POST") return new Response(null, { status: 405 });
			calls++;
			observedDispatch.push(observer.ledger.get(input.binding).dispatchAtMs);
			return new Response("synthetic rejection", { status: 503 });
		},
	});
	try {
		f.tx(() => f.ledger.prepare(input));
		f.tx(() =>
			f.ledger.recordManifest(input.binding, {
				sha256: "c".repeat(64),
				size: 1200,
			}),
		);
		f.time(1250);
		const beforeSubmit = () => {
			f.tx(() => f.ledger.beforeSubmit(input.binding));
		};
		const submit = () => {
			beforeSubmit();
			return fetch(server.url, {
				method: "POST",
				body: JSON.stringify({ id: input.binding.jobId }),
			});
		};
		const response = await submit();
		expect(response.status).toBe(503);
		await response.text();
		expect(observedDispatch).toEqual([1250]);
		f.time(1800);
		f.save("preflight", input.binding.attemptId, 1, true);
		expect(() =>
			f.tx(() => f.ledger.settle(input.binding, { kind: "no_post" })),
		).toThrow(/dispatch/);
		f.tx(() => f.ledger.settle(input.binding, { kind: "failed" }));
		expect(() => submit()).toThrow(/dispatch/);
		expect(calls).toBe(1);
		expect(f.ledger.usage("world").count).toEqual({
			reserved: 0,
			consumed: 1,
			total: 1,
		});
		expect(f.ledger.usage("world").storage.outputBytes).toBe(0);
		f.time(2250);
		expect(f.ledger.usage("world").count.total).toBe(0);
	} finally {
		await server.stop(true);
		f.close();
	}
});

test("real file written before receipt reopens as one retained orphan and adopts under exact UUID/hash", () => {
	const f = accountingFixture();
	try {
		const input = f.input();
		f.tx(() => f.ledger.prepare(input));
		f.tx(() => f.ledger.beforeSubmit(input.binding));
		f.tx(() =>
			f.ledger.settle(input.binding, {
				kind: "result",
				resultFilename: "result.png",
			}),
		);
		const file = `${f.path}.${input.binding.jobId}.png`;
		const png = Buffer.from(
			"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jXioAAAAASUVORK5CYII=",
			"base64",
		);
		writeFileSync(file, png);
		const receipt = () => {
			const bytes = readFileSync(file);
			return {
				id: input.binding.jobId,
				sha256: createHash("sha256").update(bytes).digest("hex"),
				mime: "image/png" as const,
				size: bytes.length,
			};
		};
		const inventory = f.connect();
		inventory.ledger.validate();
		// Until inventory records it, the original reservation still covers this file.
		expect(inventory.ledger.usage("world").storage.outputBytes).toBe(2_097_152);
		f.tx(
			() => inventory.ledger.recordOrphan(input.binding, receipt()),
			inventory.db,
		);
		const reopened = f.connect();
		reopened.ledger.validate();
		f.tx(
			() => reopened.ledger.importOutput(input.binding, receipt()),
			reopened.db,
		);
		f.tx(
			() => reopened.ledger.importOutput(input.binding, receipt()),
			reopened.db,
		);
		expect(reopened.ledger.usage("world").storage.outputBytes).toBe(68);
		expect(reopened.ledger.usage("world").storage.assets).toBe(1);
		expect(reopened.ledger.usage("world").count.consumed).toBe(1);
		writeFileSync(file, Buffer.concat([png, Buffer.from([1])]));
		expect(() =>
			f.tx(
				() => reopened.ledger.importOutput(input.binding, receipt()),
				reopened.db,
			),
		).toThrow(/conflict/);
		expect(reopened.ledger.usage("world").storage.outputBytes).toBe(68);
	} finally {
		f.close();
	}
});

test("archived abandoned result can reacquire and import without reopening count or generating", () => {
	const f = accountingFixture();
	try {
		const input = f.input();
		f.tx(() => f.ledger.prepare(input));
		f.tx(() =>
			f.ledger.recordManifest(input.binding, {
				sha256: "c".repeat(64),
				size: 1000,
			}),
		);
		f.tx(() => f.ledger.beforeSubmit(input.binding));
		f.tx(() =>
			f.ledger.settle(input.binding, {
				kind: "result",
				resultFilename: "result.png",
			}),
		);
		f.tx(() => f.ledger.abandonOutput(input.binding));
		const archive = { sha256: "d".repeat(64), size: 1000 };
		f.tx(() => f.ledger.archive(input.binding, archive, true));
		f.time(4000);
		f.save("config", "world", 2, {
			...f.config,
			revision: 2,
			images: null,
			avatars: null,
			usage: null,
		});
		const reopened = f.connect();
		reopened.ledger.validate();
		f.tx(() => reopened.ledger.reacquireOutput(input.binding), reopened.db);
		f.tx(
			() =>
				reopened.ledger.importOutput(input.binding, {
					id: input.binding.jobId,
					sha256: "b".repeat(64),
					mime: "image/png",
					size: 50,
				}),
			reopened.db,
		);
		expect(reopened.ledger.get(input.binding).dispatchAtMs).toBe(1000);
		expect(reopened.ledger.usage("world").storage).toMatchObject({
			archivedJobs: 1,
			activeJobs: 0,
			outputBytes: 50,
		});
		expect(() =>
			f.tx(() => reopened.ledger.beforeSubmit(input.binding), reopened.db),
		).toThrow(/dispatch/);
		f.tx(
			() => reopened.ledger.archive(input.binding, archive, true),
			reopened.db,
		);
		f.connect().ledger.validate();
	} finally {
		f.close();
	}
});
