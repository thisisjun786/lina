import { afterEach, expect, test } from "bun:test";
import { DatabaseSync } from "node:sqlite";
import { parseLifeConfigInput } from "../src/world/authoring-request-validation.ts";
import { buildLifeModelInput } from "../src/world/autonomy-views.ts";
import { selectLifeEvent } from "../src/world/events.ts";
import { lifeDigest } from "../src/world/life-json.ts";
import { WorldStore } from "../src/world/store.ts";
import { projectPublication } from "../src/world/views.ts";
import { autonomyStoreFixture } from "./life-autonomy-store-fixture.ts";
import { workInput } from "./life-work-fixture.ts";

const close: Array<() => void> = [];
afterEach(() => {
	for (const fn of close.splice(0).reverse()) fn();
});
function fixture(requiredMatch = false) {
	const f = autonomyStoreFixture(false);
	close.push(() => f.close());
	const { worldId, revision, ...config } = f.store.lifeConfig(
		f.request.worldId,
	);
	const familyId = f.source.pack.eventFamilies[0]?.id;
	if (!familyId) throw Error("Missing family");
	f.store.setLifeConfig(
		worldId,
		revision,
		parseLifeConfigInput({
			...config,
			version: 2,
			work: {
				rules: [
					{
						id: "research",
						familyId,
						categoryId: "research",
						outcomes: [],
						attribution: "owner",
						weight: 7,
						requiredMatch,
					},
				],
			},
		}),
	);
	f.request.expectedConfigRevision++;
	return f;
}
test("a versioned autonomous step freezes work evidence, changes selection and restores without re-reading current permission", () => {
	const f = fixture(),
		worldId = f.request.worldId;
	f.store.admitWorkInput(workInput(worldId));
	const step = f.store.prepareLifeStep(f.request, () => 1);
	expect(step.version).toBe(2);
	expect(step.source.work).toEqual(f.store.workEvidence(worldId));
	const candidate = step.decision.candidates.find((x) => x.agentId === "lina");
	expect(candidate?.contributions).toContainEqual({
		kind: "work",
		id: "research",
		value: 7,
	});
	const model = buildLifeModelInput(
		{ ...step, decision: { ...step.decision, agentId: "lina" } },
		"director",
		"lina",
	);
	expect(model.input).toContain("Finished research");
	expect(model.input).not.toContain('"taskId"');
	expect(model.input).not.toContain('"receiptId"');
	f.store.admitWorkInput(workInput(worldId, 2, true));
	expect(f.store.lifeStep(worldId, step.id).status).toBe("stale");
	expect(() =>
		f.store.finishLifeStep(step.lease, step.id, f.clock()),
	).toThrow();
	f.store.close();
	const reopened = new WorldStore(f.path, f.clock);
	close.push(() => reopened.close());
	expect(reopened.lifeStep(worldId, step.id).source.work).toEqual(
		step.source.work,
	);
	expect(reopened.lifeStep(worldId, step.id).decision).toEqual(step.decision);
});
test("required work match and unshared participant details cannot expose an owner's work to other agents", () => {
	const f = fixture(true),
		worldId = f.request.worldId;
	const before = f.store.prepareLifeStep(f.request, () => 1);
	expect(before.decision.candidates).toHaveLength(0);
	f.store.admitWorkInput(workInput(worldId));
	const next = f.store.prepareLifeStep(
		{ ...f.request, idempotencyKey: "with-work" },
		() => 1,
	);
	expect(next.decision.candidates.map((x) => x.agentId)).toEqual(["lina"]);
	const source = {
		...next.source,
		work: { ...f.store.workEvidence(worldId), records: [] },
	};
	expect(selectLifeEvent(source, "without-work").candidates).toHaveLength(0);
});

test("work experience commits once independently of sharing revisions and survives quiet-step recovery", () => {
	const f = autonomyStoreFixture();
	close.push(() => f.close());
	const worldId = f.request.worldId;
	const { worldId: _id, revision, ...config } = f.store.lifeConfig(worldId);
	f.store.setLifeConfig(
		worldId,
		revision,
		parseLifeConfigInput({
			...config,
			version: 2,
			work: {
				rules: [
					{
						id: "work",
						familyId: "meet",
						categoryId: "research",
						outcomes: [],
						attribution: "owner",
						weight: 1,
						requiredMatch: false,
					},
				],
			},
		}),
	);
	f.request.expectedConfigRevision++;
	f.store.admitWorkInput(workInput(worldId));
	let step = f.store.prepareLifeStep(f.request, () => 1);
	step = f.store.finishLifeStep(step.lease, step.id, f.clock());
	const commit = step.outcome?.commit;
	expect(commit?.experiences).toHaveLength(1);
	expect(commit?.experiences[0]?.agentId).toBe("lina");
	expect(commit?.consumedInputIds).toEqual(["delivery-1"]);
	f.store.acceptLifeStep(
		step.lease,
		step.id,
		{ identity: f.request.identity, modelSettingsRevision: 1 },
		f.clock(),
	);
	expect(f.store.lifeSnapshot(worldId).claims[0]?.text).toBe(
		"Finished research",
	);
	f.store.admitWorkInput(workInput(worldId, 2));
	const next = f.store.prepareLifeStep(
		{ ...f.request, idempotencyKey: "second" },
		() => 1,
	);
	const finished = f.store.finishLifeStep(next.lease, next.id, f.clock());
	expect(finished.outcome?.commit.experiences).toEqual([]);
	f.store.acceptLifeStep(
		next.lease,
		next.id,
		{ identity: f.request.identity, modelSettingsRevision: 1 },
		f.clock(),
	);
	f.store.close();
	const reopened = new WorldStore(f.path, f.clock);
	close.push(() => reopened.close());
	expect(reopened.lifeSnapshot(worldId).experiences).toHaveLength(1);
	expect(
		reopened.acceptLifeStep(
			step.lease,
			step.id,
			{ identity: f.request.identity, modelSettingsRevision: 1 },
			f.clock(),
		).replayed,
	).toBe(true);
	const claim = reopened.lifeSnapshot(worldId).claims[0];
	if (!claim) throw Error("Missing work claim");
	expect(
		reopened.workSubjectAllowed(worldId, { kind: "life_claim", id: claim.id }),
	).toBe(false); // prior re-share must not silently reauthorize an old derivative
	reopened.admitWorkInput(workInput(worldId, 3, true));
	const after = reopened.prepareLifeStep(
		{ ...f.request, idempotencyKey: "restricted" },
		() => 1,
	);
	const view = buildLifeModelInput(
		{ ...after, decision: { ...after.decision, agentId: "lina" } },
		"director",
		"lina",
	);
	expect(view.input).not.toContain("Finished research");
	const world = reopened.snapshot(worldId),
		life = reopened.lifeSnapshot(worldId),
		projection = {
			...reopened.lifeDefinition(worldId).projection,
			disclosures: [
				{
					subject: { kind: "life_claim" as const, id: claim.id },
					policy: {
						knowers: ["lina"],
						disclosures: [{ agentId: "lina", recipientId: "owner" }],
						publication: ["owner"],
					},
				},
			],
		};
	const publication = projectPublication(
		world,
		life,
		[],
		projection,
		{ purpose: "publication", worldId, agentId: "lina", recipientId: "owner" },
		{ maxChars: 10000, maxRecords: 100 },
		(subject) => reopened.workSubjectAllowed(worldId, subject),
	);
	expect(publication.claims).toEqual([]);
});

test("receipt retraction creates one neutral correction observation without leaking the old summary or private reason", () => {
	const f = autonomyStoreFixture();
	close.push(() => f.close());
	const worldId = f.request.worldId;
	const { worldId: _world, revision, ...config } = f.store.lifeConfig(worldId);
	f.store.setLifeConfig(worldId, revision, {
		...config,
		version: 2,
		work: {
			rules: [
				{
					id: "work",
					familyId: "meet",
					categoryId: "research",
					outcomes: [],
					attribution: "owner",
					weight: 1,
					requiredMatch: false,
				},
			],
		},
	});
	f.request.expectedConfigRevision++;
	const accept = (key: string) => {
		let step = f.store.prepareLifeStep(
			{ ...f.request, idempotencyKey: key },
			() => 1,
		);
		step = f.store.finishLifeStep(step.lease, step.id, f.clock());
		f.store.acceptLifeStep(
			step.lease,
			step.id,
			{ identity: f.request.identity, modelSettingsRevision: 1 },
			f.clock(),
		);
		return step;
	};
	f.store.admitWorkInput(workInput(worldId));
	accept("original");
	const restriction = workInput(worldId, 2, true);
	restriction.source.receipt = {
		...restriction.source.receipt,
		receiptRevision: 2,
		supersedesRevision: 1,
		correction: { kind: "retract", reason: "PRIVATE_CORRECTION_REASON" },
	};
	restriction.sourceRevision = 2;
	restriction.payloadDigest = lifeDigest(restriction.source);
	f.store.admitWorkInput(restriction);
	const corrected = accept("correction");
	expect(corrected.outcome?.commit.experiences).toHaveLength(1);
	const next = f.store.prepareLifeStep(
		{ ...f.request, idempotencyKey: "after-correction" },
		() => 1,
	);
	const model = buildLifeModelInput(
		{ ...next, decision: { ...next.decision, agentId: "lina" } },
		"director",
		"lina",
	);
	expect(model.input).toContain(
		"Previously shared work evidence was retracted.",
	);
	expect(model.input).not.toContain("Finished research");
	expect(model.input).not.toContain("PRIVATE_CORRECTION_REASON");
	f.store.finishLifeStep(next.lease, next.id, f.clock());
	expect(
		f.store.lifeStep(worldId, next.id).outcome?.commit.experiences,
	).toEqual([]);
	f.store.close();
	const reopened = new WorldStore(f.path, f.clock);
	close.push(() => reopened.close());
	expect(reopened.lifeSnapshot(worldId).experiences).toHaveLength(2);
});

test("W1 restore rejects omitted frozen work inbox inputs even when the step digest is rewritten", () => {
	const f = fixture(),
		worldId = f.request.worldId;
	f.store.admitWorkInput(workInput(worldId));
	const step = f.store.prepareLifeStep(f.request, () => 1);
	f.store.close();
	const db = new DatabaseSync(f.path);
	const row = db
		.prepare("SELECT step_json FROM life_steps WHERE step_id=?")
		.get(step.id);
	if (!row) throw Error("Missing step");
	const altered = JSON.parse(String(row["step_json"]));
	altered.source.inputs = [];
	db.prepare("UPDATE life_steps SET step_json=?,digest=? WHERE step_id=?").run(
		JSON.stringify(altered),
		lifeDigest(altered),
		step.id,
	);
	db.close();
	expect(() => new WorldStore(f.path, f.clock).close()).toThrow(
		/input|source/i,
	);
});
test("W2 work consumed without a matching outcome cannot become a new experience through settings alone", () => {
	const f = autonomyStoreFixture();
	close.push(() => f.close());
	const worldId = f.request.worldId;
	const { worldId: _world, revision, ...config } = f.store.lifeConfig(worldId);
	const configured = {
		...config,
		version: 2 as const,
		work: {
			rules: [
				{
					id: "work",
					familyId: "meet",
					categoryId: "research",
					outcomes: ["failed" as const],
					attribution: "owner" as const,
					weight: 1,
					requiredMatch: false,
				},
			],
		},
	};
	f.store.setLifeConfig(worldId, revision, configured);
	f.request.expectedConfigRevision++;
	f.store.admitWorkInput(workInput(worldId));
	const first = f.store.prepareLifeStep(f.request, () => 1);
	f.store.finishLifeStep(first.lease, first.id, f.clock());
	f.store.acceptLifeStep(
		first.lease,
		first.id,
		{ identity: f.request.identity, modelSettingsRevision: 1 },
		f.clock(),
	);
	expect(f.store.lifeSnapshot(worldId).experiences).toEqual([]);
	expect(f.store.lifeInputs(worldId)[0]?.consumedLifeRevision).toBe(1);
	const rule = configured.work.rules[0];
	if (!rule) throw Error("Missing rule");
	rule.outcomes = [];
	f.store.setLifeConfig(worldId, 2, configured);
	const next = f.store.prepareLifeStep(
		{
			...f.request,
			idempotencyKey: "changed-outcomes",
			expectedConfigRevision: 3,
		},
		() => 1,
	);
	const finished = f.store.finishLifeStep(next.lease, next.id, f.clock());
	expect(finished.outcome?.commit.experiences).toEqual([]);
});
