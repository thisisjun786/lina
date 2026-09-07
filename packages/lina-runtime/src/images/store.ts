import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { type Static, Type } from "typebox";
import { Value } from "typebox/value";
import {
	atomicJson,
	checkedDirectory,
	checkedRegular,
	readRegular,
} from "../../../lina-core/src/attachments/filesystem.ts";
import type { AttachmentMetadata } from "../../../lina-core/src/attachments/types.ts";
import {
	ATTACHMENT_MAX_BYTES,
	metadataShape,
} from "../../../lina-core/src/attachments/validation.ts";
import type { BotBinding } from "../../../lina-core/src/protocol.ts";
import { validateBinding } from "../../../lina-core/src/session-binding.ts";
import { resultSchema } from "./client-contract.ts";

const MAX_JOBS = 256;
const MAX_STORE_BYTES = 8 * 1024 * 1024;
const uuid = Type.String({
	pattern:
		"^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
});
const text = (maxLength: number) => Type.String({ minLength: 1, maxLength });
const nullable = <T extends ReturnType<typeof Type.String>>(schema: T) =>
	Type.Union([schema, Type.Null()]);
const inputSchema = Type.Object(
	{
		requestId: text(256),
		callId: text(256),
		provider: text(128),
		model: text(256),
		prompt: text(16000),
		sourceArtifactId: nullable(uuid),
	},
	{ additionalProperties: false },
);
const recordSchema = Type.Object(
	{
		...inputSchema.properties,
		id: uuid,
		state: Type.Union([
			Type.Literal("prepared"),
			Type.Literal("submitting"),
			Type.Literal("queued"),
			Type.Literal("running"),
			Type.Literal("post_processing"),
			Type.Literal("uncertain"),
			Type.Literal("cancelling"),
			Type.Literal("completed"),
			Type.Literal("failed"),
			Type.Literal("cancelled"),
		]),
		endpoint: nullable(text(2048)),
		runtimeVersion: nullable(text(128)),
		createdAt: text(64),
		updatedAt: text(64),
		error: nullable(text(512)),
		cancelRequested: Type.Boolean(),
		resultFilename: nullable(text(255)),
		deliveryError: nullable(text(512)),
		artifact: Type.Union([
			Type.Object(
				{
					id: uuid,
					name: text(120),
					mime: text(128),
					size: Type.Integer({ minimum: 1, maximum: ATTACHMENT_MAX_BYTES }),
					sha256: Type.String({ pattern: "^[a-f0-9]{64}$" }),
				},
				{ additionalProperties: false },
			),
			Type.Null(),
		]),
		deliveredEntryId: nullable(text(256)),
	},
	{ additionalProperties: false },
);
export type ImageJobInput = Static<typeof inputSchema>;
export type ImageJobState = Static<typeof recordSchema>["state"];
export type ImageJob = Omit<Static<typeof recordSchema>, "artifact"> & {
	artifact: AttachmentMetadata | null;
};
export function terminalImageState(state: ImageJobState): boolean {
	return state === "completed" || state === "failed" || state === "cancelled";
}
function parseJob(raw: unknown): ImageJob {
	if (!Value.Check(recordSchema, raw)) throw Error("Invalid image job record");
	if (
		raw.resultFilename !== null &&
		!resultSchema.safeParse({ requestId: raw.id, filename: raw.resultFilename })
			.success
	)
		throw Error("Invalid image result filename");
	if (raw.artifact) {
		metadataShape(raw.artifact);
		if (raw.artifact.id !== raw.id)
			throw Error("Invalid image artifact identity");
	}
	if ((raw.state === "completed") !== (raw.artifact !== null))
		throw Error("Invalid image artifact state");
	return raw as ImageJob;
}
/** The session lifetime lease owns writes; this manifest never shares task-engine state. */
export class ImageJobStore {
	readonly binding: BotBinding;
	private readonly path: string;
	private jobs: ImageJob[] = [];
	constructor(root: string, binding: BotBinding) {
		this.binding = validateBinding(binding);
		const dir = checkedDirectory(join(root, "images"), true);
		this.path = join(dir, "jobs.json");
		if (!existsSync(this.path)) {
			this.save([]);
			return;
		}
		checkedRegular(this.path);
		const raw: unknown = JSON.parse(
			new TextDecoder().decode(readRegular(this.path, MAX_STORE_BYTES)),
		);
		if (
			!raw ||
			typeof raw !== "object" ||
			!("binding" in raw) ||
			!("jobs" in raw) ||
			!("version" in raw) ||
			raw.version !== 1 ||
			Object.keys(raw).length !== 3 ||
			!isDeepStrictEqual(raw.binding, this.binding) ||
			!Array.isArray(raw.jobs)
		)
			throw Error("Invalid image store binding or schema");
		this.jobs = raw.jobs.map(parseJob);
		if (
			this.jobs.length > MAX_JOBS ||
			new Set(this.jobs.map((j) => j.id)).size !== this.jobs.length ||
			new Set(this.jobs.map((j) => `${j.requestId}\0${j.callId}`)).size !==
				this.jobs.length
		)
			throw Error("Invalid image store records");
	}
	list(): ImageJob[] {
		return structuredClone(this.jobs);
	}
	get(id: string): ImageJob {
		const job = this.jobs.find((j) => j.id === id);
		if (!job) throw Error("Image job not found in this conversation");
		return structuredClone(job);
	}
	create(input: ImageJobInput): ImageJob {
		if (!Value.Check(inputSchema, input)) throw Error("Invalid image request");
		const previous = this.jobs.find(
			(j) => j.requestId === input.requestId && j.callId === input.callId,
		);
		if (previous) {
			if (
				Object.keys(input).some(
					(key) =>
						!isDeepStrictEqual(
							previous[key as keyof ImageJob],
							input[key as keyof ImageJobInput],
						),
				)
			)
				throw Error("Image request ID conflict");
			return structuredClone(previous);
		}
		if (this.jobs.length >= MAX_JOBS)
			throw Error("Image job storage limit reached");
		const stamp = new Date().toISOString();
		const job: ImageJob = {
			...input,
			id: randomUUID(),
			state: "prepared",
			endpoint: null,
			runtimeVersion: null,
			createdAt: stamp,
			updatedAt: stamp,
			error: null,
			cancelRequested: false,
			resultFilename: null,
			deliveryError: null,
			artifact: null,
			deliveredEntryId: null,
		};
		this.save([...this.jobs, job]);
		return structuredClone(job);
	}
	update(
		id: string,
		patch: Partial<
			Pick<
				ImageJob,
				| "state"
				| "endpoint"
				| "runtimeVersion"
				| "error"
				| "artifact"
				| "deliveredEntryId"
				| "cancelRequested"
				| "resultFilename"
				| "deliveryError"
			>
		>,
	): ImageJob {
		const current = this.get(id);
		if (
			terminalImageState(current.state) &&
			Object.keys(patch).some(
				(k) => k !== "deliveredEntryId" && k !== "deliveryError",
			)
		)
			throw Error("Image job is terminal");
		const job = parseJob({
			...current,
			...patch,
			updatedAt: new Date().toISOString(),
		});
		this.save(this.jobs.map((j) => (j.id === id ? job : j)));
		return structuredClone(job);
	}
	private save(jobs: ImageJob[]): void {
		const next = { version: 1, binding: this.binding, jobs };
		if (Buffer.byteLength(JSON.stringify(next)) > MAX_STORE_BYTES)
			throw Error("Image job storage limit reached");
		atomicJson(this.path, next);
		this.jobs = jobs;
	}
}
