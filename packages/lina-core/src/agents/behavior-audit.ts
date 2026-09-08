import type { DatabaseSync } from "node:sqlite";
import { isDeepStrictEqual } from "node:util";
import type {
	BehaviorJob,
	BehaviorProfileGetter,
	BehaviorReceipt,
} from "./behavior-types.ts";
import {
	behaviorFingerprint,
	behaviorReceiptStamp,
	parseBehaviorFailReason,
	parseBehaviorJobInput,
	parseBehaviorJobState,
	parseBehaviorSourceStamp,
	parsePersonalBehaviorOutput,
} from "./behavior-validation.ts";

function counter(value: unknown, minimum = 0): number {
	if (
		typeof value !== "number" ||
		!Number.isSafeInteger(value) ||
		value < minimum
	)
		throw Error("corrupt behavior counter");
	return value;
}
export function decodeBehaviorJob(row: Record<string, unknown>): BehaviorJob {
	const input = parseBehaviorJobInput(JSON.parse(String(row["input_json"]))),
		fingerprint = behaviorFingerprint(input);
	if (
		row["id"] !== "behavior-" + fingerprint ||
		row["fingerprint"] !== fingerprint ||
		row["agent_id"] !== input.agentId ||
		row["world_id"] !== input.worldId
	)
		throw Error("corrupt behavior job binding");
	const state = parseBehaviorJobState(row["state"]),
		attempts = counter(row["attempts"]),
		token = row["claim_token"],
		error =
			row["error"] === null ? null : parseBehaviorFailReason(row["error"]);
	const resultRevision =
		row["result_revision"] === null ? null : counter(row["result_revision"], 1);
	if (
		attempts > input.maxAttempts ||
		(state === "prepared"
			? typeof token !== "string" || !token.length || token.length > 160
			: token !== null) ||
		(state === "committed") !== (resultRevision !== null) ||
		(state === "failed" || state === "withheld") !== (error !== null) ||
		(state !== "pending" && attempts === 0)
	)
		throw Error("corrupt behavior job lifecycle");
	return {
		id: String(row["id"]),
		agentId: input.agentId,
		worldId: input.worldId,
		fingerprint,
		input,
		state,
		attempts,
		token: typeof token === "string" ? token : null,
		error,
		resultRevision,
	};
}
export function decodeBehaviorReceipt(
	row: Record<string, unknown>,
	job: BehaviorJob,
): BehaviorReceipt {
	const input = parseBehaviorJobInput(JSON.parse(String(row["input_json"]))),
		output = parsePersonalBehaviorOutput(
			JSON.parse(String(row["output_json"])),
			input,
		),
		revision = counter(row["revision"], 1),
		id = String(row["id"]);
	const sourceStamp = parseBehaviorSourceStamp(
		JSON.parse(String(row["stamp_json"])),
	);
	if (
		!isDeepStrictEqual(input, job.input) ||
		row["agent_id"] !== input.agentId ||
		row["world_id"] !== input.worldId ||
		row["job_id"] !== job.id ||
		id !== `behavior-receipt-${job.id}-${revision}` ||
		job.state !== "committed" ||
		job.resultRevision !== revision ||
		row["prompt_digest"] !== input.promptDigest ||
		!isDeepStrictEqual(
			sourceStamp,
			behaviorReceiptStamp(id, revision, input, output),
		)
	)
		throw Error("corrupt behavior receipt binding or digest");
	return {
		id,
		jobId: job.id,
		agentId: input.agentId,
		worldId: input.worldId,
		revision,
		input,
		output,
		promptDigest: input.promptDigest,
		sourceStamp,
	};
}
export function auditBehavior(
	db: DatabaseSync,
	profile: BehaviorProfileGetter,
): void {
	const jobs = new Map(
		db
			.prepare("SELECT * FROM agent_behavior_jobs")
			.all()
			.map((row) => {
				const job = decodeBehaviorJob(row);
				if (!profile(job.agentId)) throw Error("missing behavior profile");
				return [job.id, job] as const;
			}),
	);
	const seen = new Set<string>(),
		revisions = new Map<string, number>();
	for (const row of db
		.prepare(
			"SELECT * FROM agent_behavior_receipts ORDER BY agent_id,world_id,revision",
		)
		.all()) {
		const job = jobs.get(String(row["job_id"]));
		if (!job) throw Error("missing behavior job");
		const receipt = decodeBehaviorReceipt(row, job),
			key = JSON.stringify([receipt.agentId, receipt.worldId]);
		if (seen.has(job.id) || receipt.revision !== (revisions.get(key) ?? 0) + 1)
			throw Error("corrupt behavior receipt sequence");
		seen.add(job.id);
		revisions.set(key, receipt.revision);
	}
	for (const job of jobs.values())
		if ((job.state === "committed") !== seen.has(job.id))
			throw Error("missing or unexpected behavior receipt");
}
