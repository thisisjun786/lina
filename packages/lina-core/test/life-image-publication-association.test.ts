import { expect, test } from "bun:test";
import { existsSync, rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import type { ImageCountRecord } from "../src/world/image-accounting-types.ts";
import type { LifeImageAttempt } from "../src/world/image-attempt-types.ts";
import {
	IMAGE_PUBLICATION_SCHEMA,
	ImagePublication,
} from "../src/world/image-publication.ts";
import type {
	LifeImageIntent,
	PublishedImageMaterial,
} from "../src/world/image-types.ts";
import { canonicalLifeJson, lifeDigest } from "../src/world/life-json.ts";
import type { EventPublicationPost } from "../src/world/publication-types.ts";

const artifact = {
	id: "00000000-0000-4000-8000-000000000001",
	sha256: "a".repeat(64),
	mime: "image/png" as const,
	size: 128,
};

function fixture(path = ":memory:", initialize = true) {
	const db = new DatabaseSync(path);
	if (initialize) {
		db.exec(
			"PRAGMA foreign_keys=ON; CREATE TABLE worlds(id TEXT PRIMARY KEY) STRICT; INSERT INTO worlds VALUES('test-world');",
		);
		db.exec(IMAGE_PUBLICATION_SCHEMA);
	}
	const source = {
		intent: {
			version: 2,
			intentId: "event-intent",
			owner: { kind: "life" as const, worldId: "test-world", agentId: "lina" },
			source: {
				kind: "event_post" as const,
				publicationId: "post-one",
				postRevision: 1,
				eventId: "test-world:1",
				worldRevision: 1,
				lifeRevision: 1,
				publicationMaterialId: "material-one",
				publicationMaterialDigest: "b".repeat(64),
				recipientId: "friends",
			},
			material: { altText: "Residents meet", prompt: "private prompt" },
		} as unknown as LifeImageIntent,
		attempt: {
			attemptId: "attempt-one",
			intentId: "event-intent",
			jobId: artifact.id,
			observation: { state: "completed", artifact },
		} as unknown as LifeImageAttempt,
		post: {
			version: 1,
			worldId: "test-world",
			id: "post-one",
			revision: 1,
			withdrawn: false,
			author: { agentId: "lina" },
			material: {
				id: "material-one",
				digest: "b".repeat(64),
				audience: ["friends"],
			},
		} as unknown as EventPublicationPost,
		current: true,
		metadataBytes: 16_384,
	};
	const currentMaterial = (): PublishedImageMaterial | null =>
		source.current
			? ({
					worldId: "test-world",
					authorAgentId: "lina",
					source: source.intent.source,
				} as PublishedImageMaterial)
			: null;
	const ledger = new ImagePublication(
		db,
		{
			intent: (worldId, intentId) =>
				worldId === "test-world" && intentId === source.intent.intentId
					? source.intent
					: null,
			attempt: (worldId, attemptId) =>
				worldId === "test-world" && attemptId === source.attempt.attemptId
					? source.attempt
					: null,
			post: (worldId, postId, revision) =>
				worldId === "test-world" &&
				postId === source.post.id &&
				revision === source.post.revision
					? source.post
					: null,
			currentMaterial: (worldId, postId, authorId, recipientId) =>
				worldId === "test-world" &&
				postId === "post-one" &&
				authorId === "lina" &&
				recipientId === "friends"
					? currentMaterial()
					: null,
			count: (worldId, attemptId): ImageCountRecord | null =>
				worldId === "test-world" && attemptId === "attempt-one"
					? ({
							reservation: {
								binding: {
									worldId: "test-world",
									intentId: "event-intent",
									attemptId: "attempt-one",
									jobId: artifact.id,
								},
								metadataBytes: source.metadataBytes,
							},
						} as ImageCountRecord)
					: null,
		},
		() => 1000,
	);
	const input = {
		worldId: "test-world",
		intentId: "event-intent",
		attemptId: "attempt-one",
		postId: "post-one",
		postRevision: 1,
		requestKey: "attach-one",
		artifact,
	};
	return {
		db,
		ledger,
		source,
		input,
		path,
		reopen: () => fixture(path, false),
	};
}

test("post image publication persists one immutable delayed attachment and replays explicit receipts", () => {
	const f = fixture();
	try {
		const first = f.ledger.record(f.input);
		expect(first).toEqual({
			kind: "post",
			receiptId: expect.any(String),
			postId: "post-one",
			postRevision: 1,
			artifactId: artifact.id,
		});
		if (first.kind !== "post") throw Error("Expected post delivery");
		expect(f.ledger.record(f.input)).toEqual(first);
		expect(f.ledger.record({ ...f.input, requestKey: "attach-retry" })).toEqual(
			first,
		);
		expect(f.ledger.asset("test-world", "post-one", "friends")).toEqual({
			kind: "post",
			receiptId: first.receiptId,
			postId: "post-one",
			postRevision: 1,
			artifactId: artifact.id,
			sha256: artifact.sha256,
			mime: "image/png",
			size: 128,
			altText: "Residents meet",
			attachmentVersion: 1,
		});
		expect(
			JSON.stringify(f.ledger.asset("test-world", "post-one", "friends")),
		).not.toContain("private prompt");
		expect(() =>
			f.ledger.record({
				...f.input,
				requestKey: "attach-two",
				artifact: { ...artifact, sha256: "c".repeat(64) },
			}),
		).toThrow("different image association");
		expect(() =>
			f.ledger.record({
				...f.input,
				requestKey: "foreign-intent",
				intentId: "other-intent",
			}),
		).toThrow("different image association");
		f.ledger.validate();
	} finally {
		f.db.close();
	}
});

test("current authority is required for association and cold asset metadata reads", () => {
	const f = fixture();
	try {
		f.ledger.record(f.input);
		f.source.current = false;
		expect(() => f.ledger.asset("test-world", "post-one", "friends")).toThrow(
			"no longer permitted",
		);
		expect(() => f.ledger.record(f.input)).toThrow("no longer permitted");
	} finally {
		f.db.close();
	}
});

test("rejects foreign recipient, indexed-column reassignment, and receipts detached from their association", () => {
	const path = `/tmp/life-image-publication-columns-${crypto.randomUUID()}.sqlite`;
	const f = fixture(path);
	try {
		f.ledger.record(f.input);
		expect(() => f.ledger.asset("test-world", "post-one", "public")).toThrow(
			"recipient is not permitted",
		);
		f.db
			.prepare("UPDATE life_image_post_associations SET recipient_id='public'")
			.run();
		const reopenColumn = f.reopen();
		try {
			expect(() => reopenColumn.ledger.validate()).toThrow(
				"Corrupt image post association",
			);
		} finally {
			reopenColumn.db.close();
		}
		f.db
			.prepare("UPDATE life_image_post_associations SET recipient_id='friends'")
			.run();
		const receipt = f.db
			.prepare("SELECT payload_json FROM life_image_post_receipts")
			.get() as { payload_json: string };
		const forged = JSON.parse(receipt.payload_json) as { attemptId: unknown };
		forged.attemptId = "foreign-attempt";
		f.db
			.prepare(
				"UPDATE life_image_post_receipts SET payload_json=?,payload_digest=?",
			)
			.run(canonicalLifeJson(forged), lifeDigest(forged));
		const reopenReceipt = f.reopen();
		try {
			expect(() => reopenReceipt.ledger.validate()).toThrow(
				"receipt does not describe its association",
			);
		} finally {
			reopenReceipt.db.close();
		}
	} finally {
		f.db.close();
		if (existsSync(path)) rmSync(path);
	}
});

test("bounds request receipt growth with the actual attempt metadata reservation", () => {
	const f = fixture();
	try {
		f.ledger.record(f.input);
		f.source.metadataBytes = 1;
		expect(() =>
			f.ledger.record({ ...f.input, requestKey: "unfunded-extra-receipt" }),
		).toThrow("metadata reservation exceeded");
	} finally {
		f.db.close();
	}
});

test("reopen rejects altered artifact provenance and duplicate attempt associations", () => {
	const path = `/tmp/life-image-publication-${crypto.randomUUID()}.sqlite`;
	const f = fixture(path);
	try {
		f.ledger.record(f.input);
		expect(() =>
			f.db
				.prepare(
					"INSERT INTO life_image_post_associations(world_id,association_id,intent_id,attempt_id,post_id,post_revision,author_agent_id,recipient_id,publication_material_id,publication_material_digest,job_id,artifact_json,artifact_digest,alt_text,attachment_version,created_at_ms,record_json,digest) SELECT world_id,'other',intent_id,attempt_id,'post-two',post_revision,author_agent_id,recipient_id,publication_material_id,publication_material_digest,job_id,artifact_json,artifact_digest,alt_text,attachment_version,created_at_ms,record_json,digest FROM life_image_post_associations",
				)
				.run(),
		).toThrow();
		f.db
			.prepare("UPDATE life_image_post_associations SET artifact_digest=?")
			.run("d".repeat(64));
		const reopened = f.reopen();
		try {
			expect(() => reopened.ledger.validate()).toThrow(
				"Corrupt image post association",
			);
		} finally {
			reopened.db.close();
		}
		f.db
			.prepare("UPDATE life_image_post_associations SET artifact_digest=?")
			.run(lifeDigest(artifact));
		f.db
			.prepare("UPDATE life_image_post_receipts SET payload_digest=?")
			.run("e".repeat(64));
		const receiptReopen = f.reopen();
		try {
			expect(() => receiptReopen.ledger.validate()).toThrow(
				"Corrupt image post request receipt",
			);
		} finally {
			receiptReopen.db.close();
		}
	} finally {
		f.db.close();
		if (existsSync(path)) rmSync(path);
	}
});
