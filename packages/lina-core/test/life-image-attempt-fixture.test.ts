import { DatabaseSync } from "node:sqlite";
import type { FrozenVisualIdentity } from "../src/agents/visual.ts";
import type { ImageCountRecord } from "../src/world/image-accounting-types.ts";
import type {
	ImageAttemptObservation,
	LifeImageAttempt,
} from "../src/world/image-attempt-types.ts";
import {
	IMAGE_ATTEMPTS_SCHEMA,
	ImageAttempts,
} from "../src/world/image-attempts.ts";
import { avatarPeriodicSource } from "../src/world/image-policy.ts";
import { canonicalLifeJson } from "../src/world/life-json.ts";
import {
	imageAvatarPolicy,
	imageStoreFixture,
} from "./life-image-store-fixture.ts";

export const jobId = "00000000-0000-4000-8000-000000000001";
export const nextJobId = "00000000-0000-4000-8000-000000000002";
export function attemptFixture() {
	const f = imageStoreFixture();
	const policy = f.store.resolveImageAvatarPolicy(
		"test-world",
		"lina",
		1,
		imageAvatarPolicy,
	);
	const source = avatarPeriodicSource(
		policy,
		f.clock(),
		f.store.lifeSnapshot("test-world").revision,
	);
	if (!source) throw Error("Missing real avatar slot");
	const visual: FrozenVisualIdentity = {
		agentId: "lina",
		profileRevision: 1,
		visualRevision: 1,
		avatarPolicyRevision: 1,
		anchors: ["blue hair"],
		textIdentity: "Approved identity",
		reference: null,
		grants: [
			{ grantId: "visual-grant", revision: 1, purpose: { kind: "avatar" } },
		],
	};
	const intent = f.store.freezeImageIntent({
		worldId: "test-world",
		agentId: "lina",
		source,
		visuals: [visual],
		requestKey: null,
	});
	const path = `${f.path}.attempts`;
	const db = new DatabaseSync(path);
	db.exec(
		"PRAGMA foreign_keys=ON; CREATE TABLE worlds(id TEXT PRIMARY KEY) STRICT; INSERT INTO worlds VALUES('test-world'); CREATE TABLE fixture_counts(attempt_id TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;",
	);
	db.exec(IMAGE_ATTEMPTS_SCHEMA);
	const ports = {
		intent: (worldId: string, intentId: string) =>
			f.store.imageIntent(worldId, intentId),
		settings: (worldId: string, at?: number) => {
			const settings = f.store.imageSettings(worldId);
			return settings && (at === undefined || at === settings.revision)
				? settings
				: null;
		},
		count: (_worldId: string, attemptId: string): ImageCountRecord | null => {
			const row = db
				.prepare("SELECT value FROM fixture_counts WHERE attempt_id=?")
				.get(attemptId) as { value: string } | undefined;
			return row ? JSON.parse(String(row.value)) : null;
		},
	};
	const ledger = new ImageAttempts(db, ports, f.clock);
	const input = {
		owner: intent.owner,
		intentId: intent.intentId,
		briefDigest: intent.briefDigest,
		requestKey: "prepare-one",
		route: { provider: "synthetic", model: "image", settingsRevision: 1 },
	};
	const tx = <T>(fn: () => T) => {
		db.exec("BEGIN IMMEDIATE");
		try {
			const value = fn();
			db.exec("COMMIT");
			return value;
		} catch (error) {
			db.exec("ROLLBACK");
			throw error;
		}
	};
	return {
		...f,
		db,
		ledger,
		intent,
		input,
		ports,
		tx,
		reopen() {
			const connection = new DatabaseSync(path);
			return {
				db: connection,
				ledger: new ImageAttempts(connection, ports, f.clock),
			};
		},
		settle(
			attempt: LifeImageAttempt,
			terminal: "failed" | "no_post" = "failed",
		) {
			if (!attempt.jobId) throw Error("Cannot settle unlinked attempt fixture");
			const count: ImageCountRecord = {
				version: 1,
				reservation: {
					binding: {
						worldId: intent.owner.worldId,
						agentId: intent.owner.agentId,
						intentId: intent.intentId,
						attemptId: attempt.attemptId,
						jobId: attempt.jobId,
						kind: "avatar",
						sourceLifeRevision: intent.createdLifeRevision,
						settingsRevision: attempt.route.settingsRevision,
						configRevision: intent.configRevision,
						frozenDigest: intent.briefDigest,
					},
					outputBytes: 1024,
					metadataBytes: 16384,
					manifestBytes: 8192,
				},
				createdAtMs: 1000,
				archived: false,
				dispatchAtMs: terminal === "failed" ? 1000 : null,
				state: terminal === "failed" ? "attempted" : "released",
				terminal,
				resultFilename: null,
			};
			db.prepare("INSERT OR REPLACE INTO fixture_counts VALUES(?,?)").run(
				attempt.attemptId,
				canonicalLifeJson(count),
			);
		},
		close() {
			db.close();
			f.close();
		},
	};
}
export const sample = (
	overrides: Partial<ImageAttemptObservation> = {},
): ImageAttemptObservation => ({
	jobId,
	state: "uncertain",
	endpoint: "https://synthetic.invalid",
	runtimeVersion: "3.14.0",
	resultFilename: null,
	artifact: null,
	error: null,
	...overrides,
});
export const artifact = {
	id: jobId,
	sha256: "b".repeat(64),
	mime: "image/png" as const,
	size: 128,
};
