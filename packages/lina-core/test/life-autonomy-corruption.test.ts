import { expect, test } from "bun:test";
import { DatabaseSync } from "node:sqlite";
import type { LifeStep } from "../src/world/autonomy-types.ts";
import { canonicalLifeJson, lifeDigest } from "../src/world/life-json.ts";
import { WorldStore } from "../src/world/store.ts";
import { autonomyStoreFixture } from "./life-autonomy-store-fixture.ts";

function rewrite(path: string, mutate: (step: LifeStep) => void): void {
	const db = new DatabaseSync(path);
	try {
		const row = db.prepare("SELECT step_json FROM life_steps").get() as {
			step_json: string;
		};
		const step = JSON.parse(row.step_json) as LifeStep;
		mutate(step);
		db.prepare("UPDATE life_steps SET step_json=?,digest=?").run(
			canonicalLifeJson(step),
			lifeDigest(step),
		);
	} finally {
		db.close();
	}
}

test("a rehashed receipt cannot substitute event identity or claim replay status", () => {
	const f = autonomyStoreFixture();
	try {
		const step = f.store.prepareLifeStep(f.request, () => 42);
		f.store.prepareLifeObservations(step.lease, step.id, null, f.clock());
		f.store.finishLifeStep(step.lease, step.id, f.clock());
		f.store.acceptLifeStep(
			step.lease,
			step.id,
			{ identity: f.source.identity, modelSettingsRevision: 1 },
			f.clock(),
		);
		rewrite(f.path, (step) => {
			if (!step.receipt) throw Error("Missing fixture receipt");
			step.receipt.eventId = "forged:99";
			step.receipt.replayed = true;
		});
		expect(() => f.store.lifeStep(step.worldId, step.id)).toThrow(
			/receipt|accept|corrupt/i,
		);
	} finally {
		f.close();
	}
});

test("a staged step cannot survive a missing autonomy baseline", () => {
	const f = autonomyStoreFixture();
	try {
		const step = f.store.prepareLifeStep(f.request, () => 42);
		const db = new DatabaseSync(f.path);
		db.exec("DELETE FROM life_autonomy_state");
		db.close();
		expect(() => f.store.lifeStep(step.worldId, step.id)).toThrow(
			/baseline|autonom/i,
		);
	} finally {
		f.close();
	}
});

for (const corruption of ["missing", "rewound"] as const) {
	test(`${corruption} schedule cannot pass restart or resurrect an old lease`, () => {
		const f = autonomyStoreFixture();
		try {
			f.store.prepareLifeStep(f.request, () => 42);
			f.advance(1000);
			const db = new DatabaseSync(f.path);
			if (corruption === "missing") db.exec("DELETE FROM life_schedules");
			else {
				const row = db
					.prepare("SELECT schedule_json FROM life_schedules")
					.get() as { schedule_json: string };
				const schedule = JSON.parse(row.schedule_json);
				schedule.lease = null;
				schedule.leaseSequence = 0;
				db.prepare("UPDATE life_schedules SET schedule_json=?,digest=?").run(
					canonicalLifeJson(schedule),
					lifeDigest(schedule),
				);
			}
			db.close();
			expect(() => {
				const reopened = new WorldStore(f.path, f.clock);
				reopened.close();
			}).toThrow(/schedule|fenc|lease/i);
			expect(() => f.store.prepareLifeStep(f.request, () => 42)).toThrow(
				/schedule|fenc|lease/i,
			);
		} finally {
			f.close();
		}
	});
}
