import { expect, test } from "bun:test";
import {
	accountingFixture,
	output,
} from "./life-image-accounting-fixture.test.ts";

const manifest = { sha256: "c".repeat(64), size: 1000 };
const archive = { sha256: "d".repeat(64), size: 1100 };

test("archive moves active count only after acknowledgement and retains all bytes/dedupe identity", () => {
	const f = accountingFixture();
	try {
		f.save("settings", "world", 1, {
			...f.settings,
			storage: { ...f.settings.storage, maxActiveJobs: 1, maxArchivedJobs: 1 },
		});
		const input = f.input();
		f.tx(() => f.ledger.prepare(input));
		f.tx(() => f.ledger.recordManifest(input.binding, manifest));
		expect(() =>
			f.tx(() => f.ledger.archive(input.binding, archive, true)),
		).toThrow(/terminal/);
		f.tx(() => f.ledger.beforeSubmit(input.binding));
		f.tx(() =>
			f.ledger.settle(input.binding, {
				kind: "result",
				resultFilename: "result.png",
			}),
		);
		expect(() =>
			f.tx(() => f.ledger.archive(input.binding, archive, true)),
		).toThrow(/storage/);
		f.tx(() =>
			f.ledger.importOutput(input.binding, output(input.binding.jobId)),
		);
		const before = f.ledger.usage("world");
		expect(() =>
			f.tx(() => f.ledger.archive(input.binding, archive, false)),
		).toThrow(/acknowledgement/);
		const receipt = f.tx(() => f.ledger.archive(input.binding, archive, true));
		const reopened = f.connect();
		reopened.ledger.validate();
		const after = reopened.ledger.usage("world");
		expect(after.count).toEqual(before.count);
		expect(after.storage.activeJobs).toBe(0);
		expect(after.storage.archivedJobs).toBe(1);
		expect(after.storage.totalBytes).toBeGreaterThan(
			before.storage.totalBytes + archive.size,
		);
		expect(after.storage.outputBytes).toBe(1024);
		expect(
			f.tx(
				() => reopened.ledger.archive(input.binding, archive, true),
				reopened.db,
			),
		).toEqual(receipt);
		expect(reopened.ledger.usage("world")).toEqual(after);
		expect(
			f.tx(() => reopened.ledger.prepare(input), reopened.db).dispatchAtMs,
		).toBe(1000);
		expect(() =>
			f.tx(() => reopened.ledger.beforeSubmit(input.binding), reopened.db),
		).toThrow(/dispatch/);
		expect(() =>
			f.tx(
				() =>
					reopened.ledger.archive(
						input.binding,
						{ ...archive, size: 999 },
						true,
					),
				reopened.db,
			),
		).toThrow(/conflict/);
		const next = f.input();
		f.tx(() => f.ledger.prepare(next));
		f.tx(() => f.ledger.recordManifest(next.binding, manifest));
		f.tx(() => f.ledger.beforeSubmit(next.binding));
		f.tx(() => f.ledger.settle(next.binding, { kind: "failed" }));
		expect(() =>
			f.tx(() => f.ledger.archive(next.binding, archive, true)),
		).toThrow(/archivedJobs/);
		expect(f.ledger.usage("world").storage).toMatchObject({
			activeJobs: 1,
			archivedJobs: 1,
		});
	} finally {
		f.close();
	}
});

test("missing archive rejects reopen instead of forgetting historical identity", () => {
	const f = accountingFixture();
	try {
		const input = f.input();
		f.tx(() => f.ledger.prepare(input));
		f.tx(() => f.ledger.recordManifest(input.binding, manifest));
		f.tx(() => f.ledger.beforeSubmit(input.binding));
		f.tx(() => f.ledger.settle(input.binding, { kind: "failed" }));
		f.tx(() => f.ledger.archive(input.binding, archive, true));
		f.db.exec("DELETE FROM life_image_archives");
		expect(() => f.connect().ledger.validate()).toThrow(/archive/);
	} finally {
		f.close();
	}
});

test.each(["maxActiveJobs", "maxAssets", "maxTotalBytes"] as const)(
	"explicit %s capacity stops admission without a count row",
	(limit) => {
		const f = accountingFixture();
		try {
			f.save("settings", "world", 1, {
				...f.settings,
				storage: { ...f.settings.storage, [limit]: 0 },
			});
			const input = f.input();
			expect(() => f.tx(() => f.ledger.prepare(input))).toThrow(/capacity/);
			expect(f.ledger.usage("world").count.total).toBe(0);
			expect(f.ledger.usage("world").storage.totalBytes).toBe(0);
		} finally {
			f.close();
		}
	},
);

test("event per-step limit persists past windows and avatar limit shares the current world window", () => {
	const f = accountingFixture();
	try {
		f.save("config", "world", 1, {
			...f.config,
			usage: { ...f.config.usage, maxImages: 8 },
			images: { mode: "manual", maxPerStep: 1 },
			avatars: { ...f.config.avatars, maxPerWindow: 1 },
		});
		const first = f.input({ sourceLifeRevision: 1 }),
			avatar = f.input({ kind: "avatar" });
		f.tx(() => f.ledger.prepare(first));
		f.tx(() => f.ledger.beforeSubmit(first.binding));
		f.tx(() => f.ledger.settle(first.binding, { kind: "failed" }));
		f.tx(() => f.ledger.prepare(avatar));
		f.time(9000);
		const duplicateStep = f.input({ sourceLifeRevision: 1 }),
			anotherAvatar = f.input({ kind: "avatar", agentId: "friend" });
		expect(() => f.tx(() => f.ledger.prepare(duplicateStep))).toThrow(
			/per-step/,
		);
		expect(() => f.tx(() => f.ledger.prepare(anotherAvatar))).toThrow(
			/Avatar.*allowance/,
		);
		f.tx(() => f.ledger.beforeSubmit(avatar.binding));
		f.tx(() => f.ledger.settle(avatar.binding, { kind: "failed" }));
		f.time(10_000);
		f.tx(() => f.ledger.prepare(anotherAvatar));
	} finally {
		f.close();
	}
});

test("current config/storage/authority changes fence POST without rewriting frozen provenance", () => {
	const f = accountingFixture();
	try {
		const input = f.input();
		f.tx(() => f.ledger.prepare(input));
		f.save("config", "world", 2, {
			...f.config,
			revision: 2,
			usage: { ...f.config.usage, maxImages: 0 },
		});
		expect(() => f.tx(() => f.ledger.beforeSubmit(input.binding))).toThrow(
			/allowance/,
		);
		f.save("config", "world", 2, { ...f.config, revision: 2 });
		f.save("settings", "world", 2, {
			...f.settings,
			revision: 2,
			storage: { ...f.settings.storage, maxTotalBytes: 0 },
		});
		expect(() => f.tx(() => f.ledger.beforeSubmit(input.binding))).toThrow(
			/capacity/,
		);
		f.save("settings", "world", 2, { ...f.settings, revision: 2 });
		f.save("revoked", input.binding.attemptId, 1, true);
		expect(() => f.tx(() => f.ledger.beforeSubmit(input.binding))).toThrow(
			/revoked/,
		);
		expect(f.ledger.get(input.binding).dispatchAtMs).toBeNull();
		expect(
			f.ledger.get(input.binding).reservation.binding.settingsRevision,
		).toBe(1);
	} finally {
		f.close();
	}
});

test("metadata and manifest changes must fit explicit independent growth bounds", () => {
	const f = accountingFixture();
	try {
		const input = f.input();
		f.tx(() => f.ledger.prepare(input));
		f.tx(() =>
			f.ledger.recordMetadata(input.binding, { ...manifest, size: 1000 }),
		);
		f.tx(() => f.ledger.recordManifest(input.binding, manifest));
		expect(() =>
			f.tx(() =>
				f.ledger.recordMetadata(input.binding, {
					...manifest,
					size: input.metadataBytes,
				}),
			),
		).toThrow(/metadata bound/);
		expect(() =>
			f.tx(() =>
				f.ledger.recordManifest(input.binding, {
					...manifest,
					size: input.manifestBytes + 1,
				}),
			),
		).toThrow(/metadata bound/);
		f.connect().ledger.validate();
		expect(f.ledger.usage("world").storage.totalBytes).toBe(2_121_728);
	} finally {
		f.close();
	}
});

test("storage reacquisition competes for capacity without spending another image", () => {
	const f = accountingFixture();
	try {
		f.save("settings", "world", 1, {
			...f.settings,
			storage: { ...f.settings.storage, maxAssets: 1 },
		});
		const first = f.input();
		f.tx(() => f.ledger.prepare(first));
		f.tx(() => f.ledger.beforeSubmit(first.binding));
		f.tx(() =>
			f.ledger.settle(first.binding, {
				kind: "result",
				resultFilename: "result.png",
			}),
		);
		f.tx(() => f.ledger.abandonOutput(first.binding));
		const second = f.input();
		f.tx(() => f.ledger.prepare(second));
		expect(() => f.tx(() => f.ledger.reacquireOutput(first.binding))).toThrow(
			/assets/,
		);
		expect(f.ledger.usage("world").count).toEqual({
			reserved: 1,
			consumed: 1,
			total: 2,
		});
		f.tx(() => f.ledger.beforeSubmit(second.binding));
		f.tx(() => f.ledger.settle(second.binding, { kind: "failed" }));
		f.tx(() => f.ledger.reacquireOutput(first.binding));
		expect(f.ledger.usage("world").count).toEqual({
			reserved: 0,
			consumed: 2,
			total: 2,
		});
	} finally {
		f.close();
	}
});
