import {
	preparedPublicationFixture,
	publicationAuthor,
} from "./life-publication-prepared-fixture.ts";

export function publishedImageFixture(
	imaginativeOnly = false,
	eventText = "Residents met at the cafe.",
	allowScene = false,
) {
	const f = preparedPublicationFixture(":memory:", eventText, allowScene);
	const claimId = f.job.material?.allowedClaims[0]?.id;
	if (!claimId) throw Error("Missing publication claim fixture");
	f.store.dispatchPublicationModel(
		f.lease,
		f.run.id,
		f.job.id,
		f.prepared.request.id,
	);
	f.store.finishPublicationModel(
		f.job.worldId,
		f.job.id,
		f.prepared.request.id,
		{
			status: "completed",
			result: {
				version: 1,
				requestId: f.prepared.request.id,
				inputDigest: f.prepared.inputDigest,
				capabilityFingerprint: f.prepared.capabilityFingerprint,
				nativeReference: f.prepared.nativeReference,
				provider: "synthetic",
				model: "narrator",
				threadId: "synthetic-thread",
				turnId: "synthetic-turn",
				text: JSON.stringify({
					kind: "post",
					segments: [
						...(imaginativeOnly ? [] : [{ kind: "claim", claimId }]),
						{
							kind: "imaginative",
							text: "There might be a secret dragon here.",
						},
					],
				}),
				usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
				upstreamAttempts: 1,
			},
		},
	);
	const completed = f.store.completePublicationJob(
		f.lease,
		f.run.id,
		f.job.id,
		{
			author: publicationAuthor,
			modelSettingsRevision: 1,
		},
	);
	if (!completed.postId) throw Error("Publication fixture failed");
	return { ...f, postId: completed.postId };
}
