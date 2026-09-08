import { expect, test } from "bun:test";
import { DatabaseSync } from "node:sqlite";
import type {
	LifeStep,
	PreparedLifeModelRequest,
} from "../src/world/autonomy-types.ts";
import { buildLifeModelInput } from "../src/world/autonomy-views.ts";
import { canonicalLifeJson, lifeDigest } from "../src/world/life-json.ts";
import { WorldStore } from "../src/world/store.ts";
import legacy from "./fixtures/life-v1-director.json";
import { autonomyStoreFixture } from "./life-autonomy-store-fixture.ts";
import { stripPublicationFixture } from "./life-publication-fixture.ts";

test("actual v5 model request serialized before shared persona reopens without changing its bytes", () => {
	const f = autonomyStoreFixture(false);
	try {
		const step = f.store.prepareLifeStep(f.request, () => 42),
			agentId = step.decision.agentId,
			route = step.source.config.models?.director;
		if (!agentId || !route) throw Error("Missing director");
		const request = {
			version: 1 as const,
			id: "legacy-director",
			worldId: step.worldId,
			stepId: step.id,
			lane: "director" as const,
			agentId,
			...route,
			modelSettingsRevision: 1,
			...buildLifeModelInput(step, "director", agentId),
			limits: {
				maxInputTokens: 100,
				maxOutputTokens: 100,
				maxInputBytes: 100000,
				maxOutputBytes: 10000,
				timeoutMs: 1000,
			},
		};
		const prepared: PreparedLifeModelRequest = {
			version: 1,
			request,
			inputDigest: lifeDigest(request),
			capabilityFingerprint: "a".repeat(64),
			nativeReference: "legacy-native",
		};
		f.store.prepareLifeModel(step.lease, step.id, prepared, f.clock());
		f.store.close();
		const db = new DatabaseSync(f.path);
		stripPublicationFixture(db);
		const stored = JSON.parse(
			String(
				db.prepare("SELECT step_json FROM life_steps").get()?.["step_json"],
			),
		) as LifeStep;
		stored.version = 1;
		delete stored.source.work;
		delete stored.source.workAncestry;
		delete stored.source.publication;
		delete stored.source.publicationAncestry;
		delete stored.source.publicationBudget;
		const model = JSON.parse(
			String(
				db.prepare("SELECT record_json FROM life_model_receipts").get()?.[
					"record_json"
				],
			),
		) as LifeStep["models"][number];
		// These bytes came from the committed 040 serializer, not the current formatter.
		Object.assign(model.prepared.request, legacy.envelope);
		model.prepared.inputDigest = lifeDigest(model.prepared.request);
		const modelBytes = canonicalLifeJson(model),
			stepBytes = canonicalLifeJson(stored);
		db.prepare("UPDATE life_model_receipts SET record_json=?,digest=?").run(
			modelBytes,
			lifeDigest(model),
		);
		db.prepare("UPDATE life_steps SET step_json=?,digest=?").run(
			stepBytes,
			lifeDigest(stored),
		);
		for (const table of [
			"life_work_ancestry",
			"life_work_experiences",
			"life_work_history",
			"life_work_state",
		])
			db.exec(`DROP TABLE ${table}`);
		db.exec("PRAGMA user_version=5");
		db.close();
		const reopened = new WorldStore(f.path, f.clock);
		try {
			const loaded = reopened.lifeStep(step.worldId, step.id);
			expect(loaded.models[0]?.prepared.request.input).toBe(
				legacy.envelope.input,
			);
			expect(loaded.models[0]?.prepared.request.systemPrompt).toBe(
				legacy.envelope.systemPrompt,
			);
			expect(loaded.version).toBe(1);
			expect(legacy.envelope.input).not.toContain("sharedPersona");
		} finally {
			reopened.close();
		}
		const check = new DatabaseSync(f.path);
		try {
			expect(
				check.prepare("SELECT record_json FROM life_model_receipts").get()?.[
					"record_json"
				],
			).toBe(modelBytes);
			expect(
				check.prepare("SELECT step_json FROM life_steps").get()?.["step_json"],
			).toBe(stepBytes);
		} finally {
			check.close();
		}
	} finally {
		f.close();
	}
});
