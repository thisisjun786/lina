import { afterEach, beforeEach, expect, test } from "bun:test";
import { join } from "node:path";
import {
	ACCEPTED_BY,
	INTENTION_KINDS,
	type IntentionRecord,
	type JudgmentSnapshotRef,
	JudgmentStore,
	MODULE_KINDS,
	parseJudgmentSnapshotRef,
	snapshotDigest,
} from "../src/agents/index.ts";
import {
	buildContextReadProjection,
	parseContextReadProjection,
} from "../src/context/index.ts";
import { ContextStore } from "../src/context/store.ts";
import { entry, Fixture } from "./fixture.ts";

let fixture: Fixture;
const stores = new Set<JudgmentStore>();
beforeEach(() => {
	fixture = new Fixture();
});
afterEach(() => {
	for (const store of stores) store.close();
	stores.clear();
	fixture.close();
});

const at = "2026-09-12T00:00:00.000Z";

function openJudgment(): JudgmentStore {
	const store = new JudgmentStore(join(fixture.dir, "judgment.sqlite"), {
		now: () => 1234,
	});
	stores.add(store);
	return store;
}

function snapshot(store: JudgmentStore): JudgmentSnapshotRef {
	for (const moduleKind of MODULE_KINDS) {
		const ref = store.putObjectiveProfile({
			schemaVersion: 1,
			objectiveId: `objective-${moduleKind}`,
			moduleKind,
			revision: 1,
			objective: "Compare outcomes",
			comparisonCriteria: ["cost"],
			reconsiderationConditions: ["new evidence"],
		});
		store.activateObjectiveProfile("agent-1", "scope-1", ref);
	}
	const refs = store.activeObjectiveProfiles("agent-1", "scope-1");
	if (!refs) throw Error("missing fixture profiles");
	return {
		schemaVersion: 1,
		roundId: "round-1",
		agentId: "agent-1",
		scopeId: "scope-1",
		sourceRefs: [],
		workingRevision: 0,
		instructionRevision: 0,
		policyId: "personal.v1",
		policyRevision: 1,
		identityRevision: 1,
		domainRevisions: {},
		intentionRevision: 0,
		objectiveProfileRefs: refs,
		observationRef: null,
		frozenNeuralRef: null,
		situation: "user_request",
		clockId: "clock-1",
		sequence: 1,
		bindingGeneration: 0,
	};
}

test("durable 256-character entry survives context projection and persisted judgment round", () => {
	const durable = fixture.store();
	// Durable requests are capped at 128; context entry IDs allow 256.
	const requestId = "r".repeat(128);
	const entryId = "e".repeat(256);
	const input = entry(entryId, { role: "user", text: "Keep the commitment" });
	expect(durable.createRequest(requestId, input.text).created).toBe(true);
	durable.registerRequestSource({
		version: 1,
		purpose: "conversation",
		sessionId: fixture.binding.sessionId,
		requestId,
		nativeEpoch: 1,
		scopeDigest: "a".repeat(64),
		contextReceiptIds: [],
	});
	expect(durable.appendSourceEntry(input, requestId)).toBe(true);
	durable.setRequest(requestId, "accepted", { entryId });
	durable.setRequest(requestId, "settled");
	const context = fixture.keep(
		new ContextStore(
			join(fixture.dir, "context.sqlite"),
			fixture.binding,
			(id) => durable.sourceEntry(id),
			{
				lookupRequest: (id) =>
					durable.sourceEntry(durable.request(id)?.entryId ?? ""),
			},
		),
	);
	const working = context.updateWorking(
		0,
		{ goal: input.text, sourceEntryIds: [entryId] },
		{ activeRequestId: requestId },
	);
	expect(context.working()).toEqual(working);
	expect(working.sourceEntryIds).toEqual([entryId]);
	const projection = buildContextReadProjection({
		working,
		instruction: { requestId, entryId, text: input.text },
		previous: null,
		projectedAt: at,
	});
	expect(
		parseContextReadProjection(JSON.parse(JSON.stringify(projection))),
	).toEqual(projection);
	const instruction = projection.instruction;
	if (!instruction) throw Error("missing fixture instruction");
	const store = openJudgment();
	const ref = {
		...snapshot(store),
		workingRevision: projection.workingRevision,
		instructionRevision: projection.instructionRevision,
		sourceRefs: [
			{ kind: "entry", id: instruction.entryId, revision: 0 },
			{ kind: "request", id: instruction.requestId, revision: 0 },
		],
	};
	expect(parseJudgmentSnapshotRef(ref)).toEqual(ref);
	expect(store.openRound(ref)).toEqual({
		roundId: ref.roundId,
		snapshotDigest: snapshotDigest(ref),
	});
	expect(store.getRound(ref.roundId)?.snapshot).toEqual(ref);
	store.close();
	stores.delete(store);
	expect(openJudgment().getRound(ref.roundId)).toEqual({
		snapshot: ref,
		status: "open",
		snapshotDigest: snapshotDigest(ref),
	});
});

test("context builder and parser preserve 256-character request and entry references for judgment", () => {
	const projection = buildContextReadProjection({
		working: {
			revision: 0,
			goal: "",
			decisions: [],
			openItems: [],
			nextSteps: [],
			sourceEntryIds: [],
		},
		instruction: {
			requestId: "r".repeat(256),
			entryId: "e".repeat(256),
			text: "Instruction",
		},
		previous: null,
		projectedAt: at,
	});
	const { instruction } = parseContextReadProjection(projection);
	if (!instruction) throw Error("missing fixture instruction");
	const ref = {
		...snapshot(openJudgment()),
		sourceRefs: [
			{ kind: "entry", id: instruction.entryId, revision: 0 },
			{ kind: "request", id: instruction.requestId, revision: 0 },
		],
	};
	expect(parseJudgmentSnapshotRef(ref)).toEqual(ref);
});

test("store rejects host-accepted user commitments without rejecting other authority pairs", () => {
	const store = openJudgment();
	for (const kind of INTENTION_KINDS) {
		for (const acceptedBy of ACCEPTED_BY) {
			const record: IntentionRecord = {
				schemaVersion: 1,
				intentionId: `${kind}-${acceptedBy}`,
				agentId: "agent-1",
				scopeId: "scope-1",
				revision: 0,
				kind,
				purposeRef: "purpose-1",
				text: "Keep the commitment",
				acceptance: {
					sourceRef: "source-1",
					acceptedBy,
					policyRevision: 1,
					acceptedAt: at,
				},
				priority: 0,
				deadline: null,
				completionCondition: "Outcome receipt",
				abortConditions: [],
				relatedIntentions: [],
				status: "proposed",
				history: [],
			};
			if (kind === "user_commitment" && acceptedBy === "host_autonomy") {
				expect(() => store.putIntention(record)).toThrow(
					"user commitment requires user acceptance",
				);
				expect(store.getIntention(record.intentionId)).toBeNull();
			} else {
				store.putIntention(record);
				expect(store.getIntention(record.intentionId)).toEqual(record);
			}
		}
	}
});
