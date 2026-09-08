import { dirname, join } from "node:path";
import { MAX_IMAGE_OUTPUT_BYTES } from "../../lina-core/src/world/image-accounting-types.ts";
import { avatarPeriodicSource } from "../../lina-core/src/world/image-policy.ts";
import { imageAvatarPolicy } from "../../lina-core/test/life-image-store-fixture.ts";
import { Ima2Client } from "../src/images/client.ts";
import { ImageJobs } from "../src/images/jobs.ts";
import {
	createLifeImageAuthority,
	lifeAvatarReservationId,
	lifeImageJobInput,
} from "../src/images/life-authority.ts";
import { ImageJobStore } from "../src/images/store.ts";
import { catalog } from "./ima2-client-fixture.ts";
import { lifeImagePermissionsFixture } from "./life-image-permissions-fixture.ts";

export function finalAuthorityFixture(hold = false) {
	const f = lifeImagePermissionsFixture(),
		world = f.store;
	const {
		worldId: _world,
		revision,
		...config
	} = world.lifeConfig("test-world");
	world.setLifeConfig("test-world", revision, {
		...config,
		usage: {
			windowMs: 1000,
			maxImages: 2,
			maxInputTokens: 100,
			maxOutputTokens: 100,
		},
	});
	const existingSettings = world.imageSettings("test-world");
	if (!existingSettings) throw Error("Missing configured image settings");
	const {
		worldId: _id,
		revision: settingsRevision,
		...settings
	} = existingSettings;
	world.setImageSettings("test-world", settingsRevision, {
		...settings,
		route: { provider: "api", model: "image-model" },
	});
	const policy = world.resolveImageAvatarPolicy(
		"test-world",
		"lina",
		f.visual.avatarPolicyRevision,
		imageAvatarPolicy,
	);
	const source = avatarPeriodicSource(
		policy,
		f.clock(),
		world.lifeSnapshot("test-world").revision,
	);
	if (!source) throw Error("Missing source");
	const intent = world.freezeImageIntent({
		...f.input,
		source,
		requestKey: "current",
	});
	const attempt = world.prepareImageAttempt(
		"test-world",
		intent.intentId,
		"run",
	);
	const store = new ImageJobStore(
		join(dirname(f.path), "image-jobs"),
		intent.owner,
		{
			maxActiveJobs: 4,
			maxArchivedJobs: 4,
			maxActiveBytes: 100000,
			maxArchiveBytes: 100000,
			maxTotalBytes: 200000,
		},
	);
	const prepared = Promise.withResolvers<void>(),
		release = Promise.withResolvers<void>();
	let posts = 0,
		foreground = false;
	const client = new Ima2Client({
		baseUrl: "http://127.0.0.1:43127",
		fetch: async (url, init) => {
			const path = new URL(url).pathname;
			if (path === "/api/health")
				return Response.json({ ok: true, version: "3.14.0" });
			if (path === "/api/models") {
				prepared.resolve();
				if (hold) await release.promise;
				return Response.json(catalog);
			}
			if (path === "/api/generate") {
				posts++;
				const body = JSON.parse(String(init.body));
				return Response.json(
					{ requestId: body.requestId, async: true },
					{ status: 202 },
				);
			}
			throw Error("Unexpected synthetic request");
		},
	});
	const jobs = new ImageJobs({
		store,
		client,
		artifacts: {
			resolveReference: () => null,
			preflight: () => {},
			importOutput: () => {
				throw Error("This queue-only scenario must not import output");
			},
			verify: () => {},
		},
		completion: { complete: () => ({ kind: "pending" }) },
	});
	const job = jobs.prepare(lifeImageJobInput(intent, attempt));
	world.linkImageAttempt("test-world", attempt.attemptId, job.id);
	world.reserveImageAttempt("test-world", attempt.attemptId, {
		outputBytes: MAX_IMAGE_OUTPUT_BYTES,
		metadataBytes: 32768,
		manifestBytes: 65536,
	});
	const frozen = f.input.visuals[0];
	if (!frozen) throw Error("Missing frozen identity");
	const admission = {
		agentId: "lina",
		worldId: "test-world",
		intentId: intent.intentId,
		materialDigest: intent.material.digest,
		resolvedPolicyId: source.resolvedPolicyId,
		profileRevision: frozen.profileRevision,
		visualRevision: frozen.visualRevision,
		avatarPolicyRevision: frozen.avatarPolicyRevision,
		source,
		grants: frozen.grants,
	};
	f.agents.admitAvatarIntent("lina", admission);
	f.agents.syncAvatarInventory([]);
	f.agents.reserveAvatarCapacity({
		reservationId: lifeAvatarReservationId("test-world", attempt.attemptId),
		owner: {
			kind: "generated",
			agentId: "lina",
			worldId: "test-world",
			intentId: intent.intentId,
			attemptId: attempt.attemptId,
		},
		maxBytes: MAX_IMAGE_OUTPUT_BYTES,
	});
	const authority = createLifeImageAuthority(
		{
			...f.services,
			invocation: "manual",
			assertLease: () => {},
			foreground: () => foreground,
		},
		"test-world",
		attempt.attemptId,
	);
	return {
		...f,
		intent,
		attempt,
		job,
		store,
		jobs,
		prepared,
		release,
		authority,
		posts: () => posts,
		foreground: () => {
			foreground = true;
		},
		close: async () => {
			release.resolve();
			await jobs.close();
			f.close();
		},
	};
}
