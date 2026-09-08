import type { DatabaseSync } from "node:sqlite";
import {
	parseLifeLease,
	parseLifeSchedule,
} from "./autonomy-record-validation.ts";
import type { LifeLease, LifeSchedule } from "./autonomy-types.ts";
import {
	canonicalLifeJson,
	identifier,
	lifeDigest,
	revision,
} from "./life-json.ts";

type Row = { world_id: string; schedule_json: string; digest: string };
/** SQL owner called within WorldStore's transaction; time comes from its trusted clock. */
export class LifeSchedulePersistence {
	constructor(
		private readonly db: DatabaseSync,
		private readonly clock: () => number,
	) {}
	get(worldId: string): LifeSchedule | null {
		identifier(worldId);
		const row = this.db
			.prepare(
				"SELECT world_id, schedule_json, digest FROM life_schedules WHERE world_id = ?",
			)
			.get(worldId) as Row | undefined;
		if (!row) {
			this.assertContinuity(worldId, null);
			return null;
		}
		const schedule = parseLifeSchedule(JSON.parse(row.schedule_json));
		if (
			row.world_id !== schedule.worldId ||
			row.digest !== lifeDigest(schedule)
		)
			throw Error("Corrupt LIFE schedule");
		this.assertContinuity(worldId, schedule);
		return schedule;
	}
	private assertContinuity(
		worldId: string,
		schedule: LifeSchedule | null,
	): void {
		const prior = this.db
			.prepare(
				"SELECT COUNT(*) AS count,MAX(json_extract(step_json,'$.lease.generation')) AS generation,MAX(json_extract(step_json,'$.lease.token')) AS token FROM life_steps WHERE world_id=?",
			)
			.get(worldId) as {
			count: number;
			generation: number | null;
			token: number | null;
		};
		if (revision(prior.count) === 0) return;
		if (
			!schedule ||
			prior.generation === null ||
			prior.token === null ||
			schedule.generation < revision(prior.generation, 1) ||
			schedule.leaseSequence < revision(prior.token, 1)
		)
			throw Error("Missing or regressed LIFE schedule fencing history");
		const lease = schedule.lease;
		if (
			lease &&
			this.db
				.prepare(
					"SELECT 1 FROM life_steps WHERE world_id=? AND json_extract(step_json,'$.lease.generation')=? AND json_extract(step_json,'$.lease.token')=? AND json_extract(step_json,'$.lease.owner')<>? LIMIT 1",
				)
				.get(worldId, lease.generation, lease.token, lease.owner)
		)
			throw Error("Corrupt LIFE schedule lease owner history");
	}
	private save(input: LifeSchedule): LifeSchedule {
		const schedule = parseLifeSchedule(input);
		this.db
			.prepare(
				"INSERT INTO life_schedules(world_id,schedule_json,digest) VALUES (?,?,?) ON CONFLICT(world_id) DO UPDATE SET schedule_json=excluded.schedule_json,digest=excluded.digest",
			)
			.run(schedule.worldId, canonicalLifeJson(schedule), lifeDigest(schedule));
		return schedule;
	}
	configure(worldId: string, configRevision: number): LifeSchedule {
		revision(configRevision);
		const current = this.get(worldId);
		if (current && configRevision < current.configRevision)
			throw Error("LIFE schedule configuration regressed");
		if (current?.configRevision === configRevision) return current;
		return this.save(
			current
				? {
						...current,
						configRevision,
						generation: revision(current.generation + 1, 1),
						lease: null,
						nextDue: null,
					}
				: {
						worldId,
						generation: 1,
						configRevision,
						lease: null,
						nextDue: null,
						lastStepId: null,
						lastClock: revision(this.clock()),
						leaseSequence: 0,
						lastSkippedIntervals: 0,
					},
		);
	}
	invalidate(worldId: string): void {
		const schedule = this.get(worldId);
		if (!schedule) return;
		this.save({
			...schedule,
			generation: revision(schedule.generation + 1, 1),
			lease: null,
			nextDue: null,
			lastClock: this.now(schedule),
		});
	}
	private now(schedule: LifeSchedule): number {
		const now = revision(this.clock());
		if (now < schedule.lastClock) throw Error("LIFE clock moved backwards");
		return now;
	}
	acquire(
		worldId: string,
		owner: string,
		configRevision: number,
		leaseMs: number,
	): LifeLease {
		identifier(owner);
		revision(leaseMs, 1);
		const schedule = this.configure(worldId, configRevision);
		const now = this.now(schedule);
		const active = schedule.lease && schedule.lease.expiresAt > now;
		if (active && schedule.lease?.owner !== owner)
			throw Error("LIFE world lease is busy");
		const token = active
			? schedule.leaseSequence
			: revision(schedule.leaseSequence + 1, 1);
		const lease: LifeLease = {
			worldId,
			owner,
			generation: schedule.generation,
			token,
			expiresAt: revision(now + leaseMs, 1),
		};
		this.save({ ...schedule, lease, leaseSequence: token, lastClock: now });
		return lease;
	}
	assert(input: LifeLease, allowExpired = false): LifeSchedule {
		const lease = parseLifeLease(input),
			schedule = this.get(lease.worldId);
		if (!schedule) throw Error("Missing LIFE schedule");
		const now = this.now(schedule),
			current = schedule.lease;
		if (
			!current ||
			current.generation !== lease.generation ||
			current.token !== lease.token ||
			current.owner !== lease.owner ||
			(!allowExpired && current.expiresAt <= now)
		)
			throw Error("Stale LIFE lease");
		return now === schedule.lastClock
			? schedule
			: this.save({ ...schedule, lastClock: now });
	}
	renew(lease: LifeLease, leaseMs: number): LifeLease {
		revision(leaseMs, 1);
		const schedule = this.assert(lease),
			now = this.now(schedule);
		const next = { ...lease, expiresAt: revision(now + leaseMs, 1) };
		this.save({ ...schedule, lease: next, lastClock: now });
		return next;
	}
	release(input: LifeLease): void {
		const lease = parseLifeLease(input),
			current = this.get(lease.worldId);
		if (!current) throw Error("Missing LIFE schedule");
		// A cancelled old owner may finish cleanup after another owner has acquired the world.
		if (
			!current.lease ||
			current.lease.generation !== lease.generation ||
			current.lease.token !== lease.token ||
			current.lease.owner !== lease.owner
		)
			return;
		const schedule = this.assert(lease, true);
		this.save({ ...schedule, lease: null, lastClock: this.now(schedule) });
	}
	advance(
		lease: LifeLease,
		nextDue: number,
		skippedIntervals: number,
	): LifeSchedule {
		const schedule = this.assert(lease);
		return this.save({
			...schedule,
			nextDue: revision(nextDue),
			lastSkippedIntervals: revision(skippedIntervals),
			lastClock: this.now(schedule),
		});
	}
	accepted(lease: LifeLease, stepId: string): void {
		const schedule = this.assert(lease);
		this.save({
			...schedule,
			lastStepId: identifier(stepId),
			lastClock: this.now(schedule),
		});
	}
	audit(): void {
		const rows = this.db
			.prepare(
				"SELECT world_id FROM life_schedules UNION SELECT world_id FROM life_steps",
			)
			.all() as Array<{ world_id: string }>;
		for (const row of rows) this.get(row.world_id);
	}
}
