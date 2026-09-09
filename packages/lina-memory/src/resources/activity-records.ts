import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import {
	parseResourceActivityReceipt,
	parseResourceActivitySource,
} from "../../../lina-core/src/world/work-activity-validation.ts";
import type { ResourceActivitySource } from "../../../lina-core/src/world/work-types.ts";
import {
	deliveryRowSchema,
	grantStateSchema,
	type ResourceActivityDeliveryRecord,
	type ResourceActivityRecord,
	recordSchema,
	resultSchema,
} from "./activity-codec.ts";
import { canonical } from "./codec.ts";
import type { ResourceStore } from "./store.ts";
import type { ResourceScope } from "./types.ts";

export function storedActivity(record: ResourceActivityRecord) {
	return {
		receipt: record.receipt,
		snapshot: record.snapshot,
		grant: record.grant,
		hostConfirmed: record.hostConfirmed,
	};
}

export function decodeActivityRecord(
	value: z.infer<typeof recordSchema>,
): ResourceActivityRecord {
	const receipt = parseResourceActivityReceipt(value.receipt);
	if (
		receipt.grantId !== value.grant.grantId ||
		receipt.grantRevision !== value.grant.grantRevision ||
		receipt.resourceId !== value.snapshot.resourceId ||
		receipt.resourceRevision !== value.snapshot.resourceRevision ||
		receipt.versionId !== value.snapshot.versionId ||
		receipt.memoryId !== value.snapshot.memoryId
	)
		throw Error("corrupt resource activity grant");
	return {
		receipt,
		snapshot: value.snapshot,
		grant: value.grant,
		hostConfirmed: value.hostConfirmed,
	};
}

export function decodeActivityRow(
	row: Record<string, unknown>,
): ResourceActivityRecord {
	const record = decodeActivityRecord(
		recordSchema.parse(JSON.parse(String(row["data"]))),
	);
	if (
		record.receipt.activityId !== row["id"] ||
		record.receipt.resourceId !== row["resource_id"] ||
		record.receipt.actorAgentId !== row["actor_agent_id"] ||
		record.receipt.activityRevision !== row["revision"]
	)
		throw Error("corrupt resource activity projection");
	return record;
}

export function loadActivity(
	db: DatabaseSync,
	activityId: string,
): ResourceActivityRecord {
	const row = db
		.prepare("SELECT * FROM resource_activities WHERE id=?")
		.get(activityId);
	if (!row) throw Error("resource activity unavailable");
	return decodeActivityRow(row);
}

export function writeActivity(
	db: DatabaseSync,
	record: ResourceActivityRecord,
): void {
	db.prepare(
		"INSERT INTO resource_activities VALUES (?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET resource_id=excluded.resource_id,actor_agent_id=excluded.actor_agent_id,revision=excluded.revision,data=excluded.data",
	).run(
		record.receipt.activityId,
		record.receipt.resourceId,
		record.receipt.actorAgentId,
		record.receipt.activityRevision,
		canonical(storedActivity(record)),
	);
}

export function writeActivityDelivery(
	db: DatabaseSync,
	record: ResourceActivityRecord,
	source: ResourceActivitySource,
): void {
	db.prepare(
		"UPDATE resource_activity_deliveries SET state='withheld' WHERE activity_id=? AND world_id=? AND state='pending'",
	).run(record.receipt.activityId, record.grant.worldId);
	db.prepare(
		"INSERT INTO resource_activity_deliveries VALUES (?,?,?,?,?,?)",
	).run(
		record.receipt.activityId,
		record.receipt.activityRevision,
		record.grant.worldId,
		record.receipt.grantRevision,
		"pending",
		canonical({
			source,
			snapshot: record.snapshot,
			ackOperationId: null,
			ackFingerprint: null,
		}),
	);
}

export function decodeActivityDelivery(
	row: Record<string, unknown>,
): ResourceActivityDeliveryRecord {
	const data = deliveryRowSchema.parse(JSON.parse(String(row["data"])));
	const source = parseResourceActivitySource(data.source);
	const state = z
		.enum(["pending", "acknowledged", "withheld"])
		.parse(row["state"]);
	if (
		source.receipt.activityId !== row["activity_id"] ||
		source.receipt.activityRevision !== row["activity_revision"] ||
		source.receipt.grantRevision !== row["grant_revision"]
	)
		throw Error("corrupt resource activity delivery");
	return { state, source };
}

export function findActivityDelivery(
	db: DatabaseSync,
	deliveryId: string,
):
	| {
			activity_id: string;
			activity_revision: number;
			world_id: string;
			grant_revision: number;
			state: "pending" | "acknowledged" | "withheld";
			data: z.infer<typeof deliveryRowSchema>;
	  }
	| undefined {
	for (const row of db
		.prepare("SELECT * FROM resource_activity_deliveries")
		.all()) {
		const data = deliveryRowSchema.parse(JSON.parse(String(row["data"])));
		const source = parseResourceActivitySource(data.source);
		if (source.deliveryId === deliveryId) {
			return {
				activity_id: String(row["activity_id"]),
				activity_revision: Number(row["activity_revision"]),
				world_id: String(row["world_id"]),
				grant_revision: Number(row["grant_revision"]),
				state: z
					.enum(["pending", "acknowledged", "withheld"])
					.parse(row["state"]),
				data,
			};
		}
	}
}

export function projectActivity(
	receipt: ResourceActivityRecord["receipt"],
	snapshot: ResourceActivityRecord["snapshot"],
	grant: z.infer<typeof grantStateSchema>,
	hostConfirmed: boolean,
): ResourceActivityRecord {
	return recordSchema.parse({
		receipt,
		snapshot,
		grant: grantStateSchema.parse(grant),
		hostConfirmed,
	}) as ResourceActivityRecord;
}

export function auditActivities(
	db: DatabaseSync,
	resources: ResourceStore,
): void {
	const activities = db
		.prepare("SELECT * FROM resource_activities ORDER BY id")
		.all();
	for (const row of activities) {
		const record = decodeActivityRow(row);
		const ops = db
			.prepare(
				"SELECT revision,result FROM resource_activity_operations WHERE activity_id=? ORDER BY revision",
			)
			.all(record.receipt.activityId);
		if (
			ops.length !== record.receipt.activityRevision ||
			ops.some((op, index) => op["revision"] !== index + 1)
		)
			throw Error("corrupt resource activity history");
		const last = resultSchema.parse(JSON.parse(String(ops.at(-1)?.["result"])));
		if (
			canonical(storedActivity(decodeActivityRecord(last.activity))) !==
			canonical(storedActivity(record))
		)
			throw Error("corrupt resource activity history");
		const ownerScope: ResourceScope = {
			principalId: record.snapshot.ownerId,
			agentId: record.receipt.actorAgentId,
			allowedVisibilities: ["private", "shared"],
		};
		const read = resources.read(
			ownerScope,
			record.snapshot.resourceId,
			record.snapshot.versionId,
		);
		if (read.version.hash !== record.snapshot.blobHash)
			throw Error("corrupt resource activity source");
	}
	for (const row of db
		.prepare("SELECT * FROM resource_activity_deliveries")
		.all()) {
		const item = decodeActivityDelivery(row);
		const record = loadActivity(db, item.source.receipt.activityId);
		if (item.source.receipt.activityRevision > record.receipt.activityRevision)
			throw Error("unknown resource activity revision");
		if (
			String(row["world_id"]) !== record.grant.worldId &&
			item.state === "pending"
		)
			throw Error("corrupt resource activity delivery");
	}
}
