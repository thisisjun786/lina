import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { openCheckedDatabase } from "../../../lina-core/src/session-binding.ts";
import { lifeDigest } from "../../../lina-core/src/world/life-json.ts";
import {
	parseResourceActivityReceipt,
	parseResourceActivitySource,
} from "../../../lina-core/src/world/work-activity-validation.ts";
import type {
	ResourceActivityOutcome,
	ResourceActivityReceipt,
	ResourceActivitySource,
} from "../../../lina-core/src/world/work-types.ts";
import {
	ackSchema,
	correctSchema,
	createSchema,
	deliveryRowSchema,
	grantSchema,
	type ResourceActivityAck,
	type ResourceActivityCorrect,
	type ResourceActivityCreate,
	type ResourceActivityDeliveryRecord,
	type ResourceActivityGrant,
	type ResourceActivityRecord,
	type ResourceActivityRestrict,
	restrictSchema,
	resultSchema,
} from "./activity-codec.ts";
import {
	auditActivities,
	decodeActivityDelivery,
	decodeActivityRecord,
	findActivityDelivery,
	loadActivity,
	projectActivity,
	storedActivity,
	writeActivity,
	writeActivityDelivery,
} from "./activity-records.ts";
import {
	initializeActivities,
	verifyActivitySchema,
} from "./activity-schema.ts";
import {
	type ActivitySnapshot,
	activitySourceCurrent,
	captureActivitySource,
} from "./activity-source.ts";
import { canonical, hash, identity, scopeSchema } from "./codec.ts";
import type { ResourceStore } from "./store.ts";
import type { ResourceScope } from "./types.ts";
export interface ResourceActivityHost {
	isWorldParticipant(worldId: string, agentId: string): boolean;
}
export type {
	ResourceActivityAck,
	ResourceActivityCorrect,
	ResourceActivityCreate,
	ResourceActivityDeliveryRecord,
	ResourceActivityGrant,
	ResourceActivityRecord,
	ResourceActivityRestrict,
} from "./activity-codec.ts";

export class ResourceActivities {
	private readonly db: DatabaseSync;
	private closed = false;
	constructor(
		root: string,
		private readonly resources: ResourceStore,
		private readonly host: ResourceActivityHost,
	) {
		const { db, fresh } = openCheckedDatabase(join(root, "activities.sqlite"));
		this.db = db;
		try {
			db.exec("BEGIN IMMEDIATE");
			initializeActivities(db, fresh);
			auditActivities(db, this.resources);
			db.exec("COMMIT; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL");
		} catch (error) {
			if (db.isTransaction) db.exec("ROLLBACK");
			db.close();
			throw error;
		}
	}
	close(): void {
		if (!this.closed) {
			this.db.close();
			this.closed = true;
		}
	}
	create(
		rawScope: ResourceScope,
		raw: ResourceActivityCreate,
	): ResourceActivityRecord {
		const scope = this.originate(
			rawScope,
			raw.actorAgentId,
			raw.participantAgentIds,
			raw.worldId,
		);
		const input = createSchema.parse(raw);
		return this.mutate(
			scope,
			input.operationId,
			hash(this.normalize("create", scope, input)),
			(replay) => {
				if (replay) return replay;
				if (
					this.db
						.prepare("SELECT id FROM resource_activities WHERE id=?")
						.get(input.activityId)
				)
					throw Error("resource activity exists");
				this.owner(scope, input.resourceId);
				const captured = captureActivitySource(this.resources, scope, input);
				const grantId = randomUUID();
				const receipt = this.receipt({
					activityId: input.activityId,
					activityRevision: 1,
					supersedesRevision: null,
					actorAgentId: input.actorAgentId,
					participantAgentIds: input.participantAgentIds,
					activityKind: input.activityKind,
					outcome: input.outcome,
					evidenceDigest: captured.evidenceDigest,
					grantId,
					grantRevision: 1,
					correction: null,
					snapshot: captured.snapshot,
				});
				const record = projectActivity(
					receipt,
					captured.snapshot,
					{
						grantId,
						grantRevision: 1,
						worldId: input.worldId,
						actorAgentId: input.actorAgentId,
						fields: input.fields,
						policyRevision: input.policyRevision,
						revoked: false,
					},
					input.hostConfirmed,
				);
				return this.commit(
					input.operationId,
					hash(this.normalize("create", scope, input)),
					record,
					this.deliver(record, "upsert", input.policyRevision),
				);
			},
		);
	}
	correct(
		rawScope: ResourceScope,
		raw: ResourceActivityCorrect,
	): ResourceActivityRecord {
		const input = correctSchema.parse(raw);
		const current = this.get(rawScope, input.activityId);
		const scope = this.originate(
			rawScope,
			current.receipt.actorAgentId,
			current.receipt.participantAgentIds,
			current.grant.worldId,
		);
		this.owner(scope, current.snapshot.resourceId);
		return this.mutate(
			scope,
			input.operationId,
			hash(this.normalize("correct", scope, input)),
			(replay) => {
				if (replay) return replay;
				const latest = loadActivity(this.db, input.activityId);
				if (latest.receipt.activityRevision !== input.expectedRevision)
					throw Error("stale resource activity revision");
				const captured = captureActivitySource(this.resources, scope, {
					resourceId: latest.snapshot.resourceId,
					versionId: latest.snapshot.versionId,
					memoryId: input.memoryId,
					quotes: input.quotes,
					outcome: input.outcome,
					hostConfirmed: input.hostConfirmed,
				});
				const retract = input.correction.kind === "retract";
				const grantRevision = retract
					? latest.grant.grantRevision + 1
					: latest.grant.grantRevision;
				const receipt = this.receipt({
					activityId: latest.receipt.activityId,
					activityRevision: latest.receipt.activityRevision + 1,
					supersedesRevision: latest.receipt.activityRevision,
					actorAgentId: latest.receipt.actorAgentId,
					participantAgentIds: latest.receipt.participantAgentIds,
					activityKind: latest.receipt.activityKind,
					outcome: input.outcome,
					evidenceDigest: captured.evidenceDigest,
					grantId: latest.grant.grantId,
					grantRevision,
					correction: input.correction,
					snapshot: captured.snapshot,
				});
				const record = projectActivity(
					receipt,
					captured.snapshot,
					{
						...latest.grant,
						grantRevision,
						fields: retract ? null : input.fields,
						policyRevision: input.policyRevision,
						revoked: retract || latest.grant.revoked,
					},
					input.hostConfirmed,
				);
				const delivery =
					retract || !record.grant.revoked
						? this.deliver(
								record,
								retract ? "restrict" : "upsert",
								input.policyRevision,
							)
						: null;
				return this.commit(
					input.operationId,
					hash(this.normalize("correct", scope, input)),
					record,
					delivery,
				);
			},
		);
	}
	grant(
		rawScope: ResourceScope,
		raw: ResourceActivityGrant,
	): ResourceActivityRecord {
		const input = grantSchema.parse(raw);
		const current = this.get(rawScope, input.activityId);
		const scope = this.originate(
			rawScope,
			current.receipt.actorAgentId,
			current.receipt.participantAgentIds,
			input.worldId,
		);
		this.owner(scope, current.snapshot.resourceId);
		return this.mutate(
			scope,
			input.operationId,
			hash(this.normalize("grant", scope, input)),
			(replay) => {
				if (replay) return replay;
				const latest = loadActivity(this.db, input.activityId);
				if (latest.receipt.activityRevision !== input.expectedRevision)
					throw Error("stale resource activity revision");
				if (latest.grant.worldId !== input.worldId)
					throw Error("resource activity world mismatch");
				if (!latest.grant.revoked)
					throw Error("resource activity grant already active");
				if (!activitySourceCurrent(this.resources, scope, latest.snapshot))
					throw Error("stale resource activity source");
				const grantRevision = latest.grant.grantRevision + 1;
				const receipt = this.receipt({
					...latest.receipt,
					activityRevision: latest.receipt.activityRevision + 1,
					supersedesRevision: latest.receipt.activityRevision,
					grantRevision,
					correction: null,
					snapshot: latest.snapshot,
				});
				const record = projectActivity(
					receipt,
					latest.snapshot,
					{
						...latest.grant,
						grantRevision,
						fields: input.fields,
						policyRevision: input.policyRevision,
						revoked: false,
					},
					latest.hostConfirmed,
				);
				return this.commit(
					input.operationId,
					hash(this.normalize("grant", scope, input)),
					record,
					this.deliver(record, "upsert", input.policyRevision),
				);
			},
		);
	}
	restrict(
		rawScope: ResourceScope,
		raw: ResourceActivityRestrict,
	): ResourceActivityRecord {
		const input = restrictSchema.parse(raw);
		const current = this.get(rawScope, input.activityId);
		const scope = this.originate(
			rawScope,
			current.receipt.actorAgentId,
			current.receipt.participantAgentIds,
			input.worldId,
		);
		this.owner(scope, current.snapshot.resourceId);
		return this.mutate(
			scope,
			input.operationId,
			hash(this.normalize("restrict", scope, input)),
			(replay) => {
				if (replay) return replay;
				const latest = loadActivity(this.db, input.activityId);
				if (latest.receipt.activityRevision !== input.expectedRevision)
					throw Error("stale resource activity revision");
				if (latest.grant.worldId !== input.worldId)
					throw Error("resource activity world mismatch");
				if (latest.grant.revoked)
					throw Error("resource activity grant already revoked");
				return this.revoke(
					input.operationId,
					hash(this.normalize("restrict", scope, input)),
					latest,
					input.policyRevision,
				);
			},
		);
	}
	/** Caller-scoped authority check. May durably revoke stale evidence; call outside ledger transactions. */
	current(
		rawScope: ResourceScope,
		worldId: string,
		rawSource: ResourceActivitySource,
	): boolean {
		const scope = scopeSchema.parse(rawScope);
		const source = parseResourceActivitySource(rawSource);
		identity.parse(worldId);
		return this.transaction(() => {
			const found = findActivityDelivery(this.db, source.deliveryId);
			if (
				!found ||
				found.world_id !== worldId ||
				lifeDigest(found.data.source) !== lifeDigest(source)
			)
				return false;
			this.seal(scope, source.receipt.activityId);
			const delivery = findActivityDelivery(this.db, source.deliveryId);
			if (
				!delivery ||
				delivery.state === "withheld" ||
				lifeDigest(delivery.data.source) !== lifeDigest(source)
			)
				return false;
			const latest = loadActivity(this.db, source.receipt.activityId);
			if (
				latest.grant.worldId !== worldId ||
				latest.receipt.activityRevision !== source.receipt.activityRevision ||
				latest.grant.grantRevision !== source.receipt.grantRevision ||
				latest.grant.policyRevision !== source.policyRevision
			)
				return false;
			if (source.operation === "restrict") return latest.grant.revoked;
			return (
				!latest.grant.revoked &&
				this.host.isWorldParticipant(worldId, source.receipt.actorAgentId) &&
				activitySourceCurrent(this.resources, scope, latest.snapshot)
			);
		});
	}
	pending(
		rawScope: ResourceScope,
		worldId?: string,
	): ResourceActivityDeliveryRecord[] {
		const scope = scopeSchema.parse(rawScope);
		return this.transaction(() => {
			for (const row of this.db
				.prepare("SELECT id FROM resource_activities ORDER BY id")
				.all()) {
				this.seal(scope, String(row["id"]));
			}
			return this.db
				.prepare(
					"SELECT * FROM resource_activity_deliveries WHERE state='pending' ORDER BY activity_id, activity_revision",
				)
				.all()
				.map((row) => decodeActivityDelivery(row))
				.filter(
					(item) =>
						item.state === "pending" &&
						(worldId === undefined ||
							loadActivity(this.db, item.source.receipt.activityId).grant
								.worldId === worldId),
				);
		});
	}
	ack(
		rawScope: ResourceScope,
		raw: ResourceActivityAck,
	): ResourceActivityDeliveryRecord {
		const scope = scopeSchema.parse(rawScope);
		const input = ackSchema.parse(raw);
		return this.transaction(() => {
			const found = findActivityDelivery(this.db, input.deliveryId);
			if (!found) throw Error("resource activity delivery unavailable");
			const fingerprint = hash({
				kind: "ack",
				principalId: scope.principalId,
				...input,
			});
			const data = deliveryRowSchema.parse(found.data);
			const source = parseResourceActivitySource(data.source);
			if (data.ackOperationId) {
				if (
					data.ackOperationId !== input.operationId ||
					data.ackFingerprint !== fingerprint
				)
					throw Error("resource activity operation conflict");
				return { state: found.state, source };
			}
			this.seal(scope, source.receipt.activityId);
			const latest = findActivityDelivery(this.db, input.deliveryId);
			if (latest?.state !== "pending")
				throw Error("resource activity delivery unavailable");
			const latestSource = parseResourceActivitySource(latest.data.source);
			if (latestSource.sourceDigest !== input.sourceDigest)
				throw Error("resource activity operation conflict");
			if (
				latestSource.operation === "upsert" &&
				!activitySourceCurrent(this.resources, scope, latest.data.snapshot)
			)
				throw Error("stale resource activity source");
			this.db
				.prepare(
					"UPDATE resource_activity_deliveries SET state='acknowledged', data=? WHERE activity_id=? AND activity_revision=? AND world_id=? AND grant_revision=?",
				)
				.run(
					canonical({
						...data,
						ackOperationId: input.operationId,
						ackFingerprint: fingerprint,
					}),
					found.activity_id,
					found.activity_revision,
					found.world_id,
					found.grant_revision,
				);
			return { state: "acknowledged", source: latestSource };
		});
	}
	get(rawScope: ResourceScope, activityId: string): ResourceActivityRecord {
		const scope = scopeSchema.parse(rawScope);
		const record = loadActivity(this.db, identity.parse(activityId));
		this.resources.get(scope, record.snapshot.resourceId);
		return record;
	}
	private originate(
		raw: ResourceScope,
		actorAgentId: string,
		participantAgentIds: string[],
		worldId: string,
	): ResourceScope {
		const scope = scopeSchema.parse(raw);
		if (scope.agentId === null)
			throw Error("unattributed scope cannot originate LIFE activity");
		if (scope.agentId !== actorAgentId)
			throw Error("resource activity actor must be the host-verified agent");
		if (!participantAgentIds.includes(actorAgentId))
			throw Error("resource activity actor is not a world participant");
		if (!this.host.isWorldParticipant(worldId, actorAgentId))
			throw Error("resource activity actor is not a world participant");
		return scope;
	}
	private owner(scope: ResourceScope, resourceId: string): void {
		const resource = this.resources.get(scope, resourceId);
		if (resource.ownerId !== scope.principalId)
			throw Error("resource owner required");
	}
	private transaction<T>(fn: () => T): T {
		this.db.exec("BEGIN IMMEDIATE");
		try {
			verifyActivitySchema(this.db);
			const result = fn();
			this.db.exec("COMMIT");
			return result;
		} catch (error) {
			if (this.db.isTransaction) this.db.exec("ROLLBACK");
			throw error;
		}
	}
	private mutate(
		scope: ResourceScope,
		operationId: string,
		fingerprint: string,
		fn: (replay: ResourceActivityRecord | undefined) => ResourceActivityRecord,
	): ResourceActivityRecord {
		return this.transaction(() =>
			fn(this.replay(scope, operationId, fingerprint)),
		);
	}
	private replay(
		scope: ResourceScope,
		operationId: string,
		fingerprint: string,
	): ResourceActivityRecord | undefined {
		const row = this.db
			.prepare(
				"SELECT * FROM resource_activity_operations WHERE operation_id=?",
			)
			.get(operationId);
		if (!row) return;
		if (row["fingerprint"] !== fingerprint)
			throw Error("resource activity operation conflict");
		const result = resultSchema.parse(JSON.parse(String(row["result"])));
		const activity = decodeActivityRecord(result.activity);
		this.resources.get(scope, activity.snapshot.resourceId);
		return activity;
	}
	private commit(
		operationId: string,
		fingerprint: string,
		record: ResourceActivityRecord,
		delivery: ResourceActivitySource | null,
	): ResourceActivityRecord {
		writeActivity(this.db, record);
		if (delivery) writeActivityDelivery(this.db, record, delivery);
		this.db
			.prepare("INSERT INTO resource_activity_operations VALUES (?,?,?,?,?)")
			.run(
				operationId,
				record.receipt.activityId,
				record.receipt.activityRevision,
				fingerprint,
				canonical({ activity: storedActivity(record), delivery }),
			);
		return record;
	}
	private revoke(
		operationId: string,
		fingerprint: string,
		latest: ResourceActivityRecord,
		policyRevision: number,
	): ResourceActivityRecord {
		const grantRevision = latest.grant.grantRevision + 1;
		const receipt = this.receipt({
			...latest.receipt,
			activityRevision: latest.receipt.activityRevision + 1,
			supersedesRevision: latest.receipt.activityRevision,
			grantRevision,
			correction: latest.receipt.correction,
			snapshot: latest.snapshot,
		});
		const record = projectActivity(
			receipt,
			latest.snapshot,
			{
				...latest.grant,
				grantRevision,
				fields: null,
				policyRevision,
				revoked: true,
			},
			latest.hostConfirmed,
		);
		return this.commit(
			operationId,
			fingerprint,
			record,
			this.deliver(record, "restrict", policyRevision),
		);
	}
	private seal(scope: ResourceScope, activityId: string): void {
		const latest = loadActivity(this.db, activityId);
		if (latest.grant.revoked) return;
		const ownerScope: ResourceScope = {
			principalId: latest.snapshot.ownerId,
			agentId: latest.receipt.actorAgentId,
			allowedVisibilities: ["private", "shared"],
		};
		const readable = activitySourceCurrent(
			this.resources,
			scope.principalId === latest.snapshot.ownerId ? scope : ownerScope,
			latest.snapshot,
		);
		if (readable) return;
		const operationId = hash({
			kind: "stale-restrict",
			activityId,
			revision: latest.receipt.activityRevision,
			blobHash: latest.snapshot.blobHash,
		});
		this.revoke(
			operationId,
			hash({
				kind: "stale-restrict",
				activityId,
				revision: latest.receipt.activityRevision,
			}),
			latest,
			latest.grant.policyRevision,
		);
	}
	private receipt(input: {
		activityId: string;
		activityRevision: number;
		supersedesRevision: number | null;
		actorAgentId: string;
		participantAgentIds: string[];
		activityKind: ResourceActivityReceipt["activityKind"];
		outcome: ResourceActivityOutcome;
		evidenceDigest: string;
		grantId: string;
		grantRevision: number;
		correction: ResourceActivityReceipt["correction"];
		snapshot: ActivitySnapshot;
	}): ResourceActivityReceipt {
		return parseResourceActivityReceipt({
			activityId: input.activityId,
			activityRevision: input.activityRevision,
			supersedesRevision: input.supersedesRevision,
			resourceId: input.snapshot.resourceId,
			resourceRevision: input.snapshot.resourceRevision,
			versionId: input.snapshot.versionId,
			memoryId: input.snapshot.memoryId,
			actorAgentId: input.actorAgentId,
			participantAgentIds: input.participantAgentIds,
			activityKind: input.activityKind,
			outcome: input.outcome,
			evidenceDigest: input.evidenceDigest,
			grantId: input.grantId,
			grantRevision: input.grantRevision,
			correction: input.correction,
		});
	}
	private deliver(
		record: ResourceActivityRecord,
		operation: "upsert" | "restrict",
		policyRevision: number,
	): ResourceActivitySource {
		const fields = operation === "restrict" ? null : record.grant.fields;
		const digestInput = {
			kind: "resource_activity" as const,
			version: 1 as const,
			operation,
			policyRevision,
			receipt: record.receipt,
			fields,
			snapshot: {
				resourceId: record.snapshot.resourceId,
				resourceRevision: record.snapshot.resourceRevision,
				versionId: record.snapshot.versionId,
				blobHash: record.snapshot.blobHash,
				memoryId: record.snapshot.memoryId,
			},
		};
		return parseResourceActivitySource({
			kind: "resource_activity",
			version: 1,
			deliveryId: randomUUID(),
			operation,
			sourceDigest: lifeDigest(digestInput),
			policyRevision,
			receipt: record.receipt,
			fields,
		});
	}
	private normalize(
		kind: string,
		scope: ResourceScope,
		input: unknown,
	): unknown {
		return {
			kind,
			principalId: scope.principalId,
			agentId: scope.agentId,
			input,
		};
	}
}
