import type {
	PreparedLifeModelRequest,
	PublicationModelRequest,
} from "../src/world/autonomy-types.ts";
import { lifeDigest } from "../src/world/life-json.ts";
import {
	buildPublicationModelInput,
	publicationModelId,
} from "../src/world/publication-model.ts";
import { publicationStoreFixture } from "./life-publication-store-fixture.ts";

export const publicationAuthor = {
	agentId: "lina",
	name: "Lina",
	voice: "Calm and concise",
	profileRevision: 1,
	behavior: { traits: [], habits: [], attitudes: [] },
};
export function preparedPublicationFixture(
	path: string,
	eventSummary?: string,
) {
	const store = publicationStoreFixture(path, eventSummary),
		run = store.beginPublicationRun(
			"test-world",
			{
				requestKey: "run",
				expectedConfigRevision: 1,
				expectedSettingsRevision: 1,
				mode: "manual",
			},
			"owner",
			100,
		),
		item = run.batch[0],
		lease = run.lease;
	if (!item || !lease) throw Error("Missing publication fixture");
	const job = store.freezePublicationJob(
		lease,
		run.id,
		item.jobId,
		publicationAuthor,
		1,
	);
	if (job.version !== 1) throw Error("Event fixture requires an event job");
	const request: PublicationModelRequest = {
		version: 2,
		id: publicationModelId(job.attemptId),
		worldId: job.worldId,
		jobId: job.id,
		lane: "publication",
		agentId: job.authorAgentId,
		provider: "synthetic",
		model: "narrator",
		modelSettingsRevision: 1,
		...buildPublicationModelInput(job),
		limits: {
			maxInputTokens: 100,
			maxOutputTokens: 100,
			maxInputBytes: 20000,
			maxOutputBytes: 10000,
			timeoutMs: 1000,
		},
	};
	const prepared: PreparedLifeModelRequest = {
		version: 1,
		request,
		inputDigest: lifeDigest(request),
		capabilityFingerprint: "a".repeat(64),
		nativeReference: "native-publication",
	};
	store.preparePublicationModel(lease, run.id, prepared);
	return { store, job, run, lease, prepared };
}
