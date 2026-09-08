import { expect, test } from "bun:test";
import { DatabaseSync } from "node:sqlite";
import { LifeSchedulePersistence } from "../src/world/autonomy-schedule.ts";
import { AUTONOMY_SCHEMA } from "../src/world/autonomy-schema.ts";

function fixture() {
	const db = new DatabaseSync(":memory:");
	db.exec(
		"CREATE TABLE worlds(id TEXT PRIMARY KEY); CREATE TABLE life_commits(world_id TEXT, life_revision INTEGER, PRIMARY KEY(world_id,life_revision)); INSERT INTO worlds VALUES ('w')",
	);
	db.exec(AUTONOMY_SCHEMA);
	let time = 100;
	return {
		db,
		schedules: new LifeSchedulePersistence(db, () => time),
		setTime: (next: number) => {
			time = next;
		},
	};
}

test("lease takeover and release never reuse an old fencing token", () => {
	const f = fixture();
	try {
		const first = f.schedules.acquire("w", "old", 1, 10);
		expect(() => f.schedules.acquire("w", "new", 1, 10)).toThrow();
		f.setTime(111);
		expect(() => f.schedules.assert(first)).toThrow();
		const next = f.schedules.acquire("w", "new", 1, 10);
		expect(next.token).toBe(first.token + 1);
		const beforeRelease = f.schedules.get("w");
		expect(() => f.schedules.release(first)).not.toThrow();
		expect(f.schedules.get("w")).toEqual(beforeRelease);
		f.schedules.release(next);
		expect(() => f.schedules.release(next)).not.toThrow();
		const third = f.schedules.acquire("w", "new", 1, 10);
		expect(third.token).toBe(next.token + 1);
		expect(() => f.schedules.renew(next, 10)).toThrow();
	} finally {
		f.db.close();
	}
});

test("configuration and clock changes cannot extend old execution authority", () => {
	const f = fixture();
	try {
		const first = f.schedules.acquire("w", "owner", 1, 10);
		f.schedules.configure("w", 2);
		expect(() => f.schedules.assert(first)).toThrow();
		const next = f.schedules.acquire("w", "owner", 2, 10);
		expect(next.generation).toBe(first.generation + 1);
		f.setTime(90);
		expect(() => f.schedules.renew(next, 100)).toThrow();
		f.setTime(109);
		expect(f.schedules.assert(next).lease?.expiresAt).toBe(110);
	} finally {
		f.db.close();
	}
});

test("every successful lease check advances the persisted clock fence", () => {
	const f = fixture();
	try {
		const lease = f.schedules.acquire("w", "owner", 1, 100);
		f.setTime(150);
		f.schedules.assert(lease);
		f.setTime(140);
		expect(() => f.schedules.assert(lease)).toThrow(/clock/i);
	} finally {
		f.db.close();
	}
});
