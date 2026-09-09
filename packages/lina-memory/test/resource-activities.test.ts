import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { lifeDigest } from "../../lina-core/src/world/life-json.ts";
import { parseResourceActivitySource } from "../../lina-core/src/world/work-activity-validation.ts";
import { ResourceActivities } from "../src/resources/activities.ts";
import { hash } from "../src/resources/codec.ts";
import { extractResource } from "../src/resources/extraction.ts";
import { ResourceStore } from "../src/resources/store.ts";

const a = {
	principalId: "agent:a",
	agentId: "a",
	allowedVisibilities: ["private", "shared"] as ("private" | "shared")[],
};
const b = { ...a, principalId: "agent:b", agentId: "b" };
const sharedOnly = {
	principalId: "external",
	agentId: null,
	allowedVisibilities: ["shared"] as "shared"[],
};
const limits = {
	maxFileBytes: 4096,
	maxCatalogBytes: 8192,
	maxExtractionBytes: 4096,
};
const host = {
	isWorldParticipant(worldId: string, agentId: string) {
		return worldId === "world-1" && agentId === "a";
	},
};
const text = (value: string) => new TextEncoder().encode(value);
const fields = {
	categoryId: "research",
	outcome: "recorded" as const,
	participantAgentIds: ["a"],
	summary: "조사 기록",
};

function open(root: string) {
	const resources = new ResourceStore(root, limits);
	const activities = new ResourceActivities(root, resources, host);
	return { resources, activities };
}

function seed(
	resources: ResourceStore,
	visibility: "private" | "shared" = "shared",
	operationId = "doc",
) {
	return resources.create(a, {
		operationId,
		kind: "document",
		title: "조사",
		visibility,
		mediaType: "text/plain",
		bytes: text("We chose paper because it is portable."),
	});
}

function recorded(
	activityId: string,
	resourceId: string,
	extra: Record<string, unknown> = {},
) {
	return {
		operationId: "create-1",
		activityId,
		worldId: "world-1",
		actorAgentId: "a",
		participantAgentIds: ["a"],
		activityKind: "research" as const,
		outcome: "recorded" as const,
		resourceId,
		versionId: null,
		memoryId: null,
		quotes: [] as string[],
		hostConfirmed: false,
		fields,
		policyRevision: 1,
		...extra,
	};
}

test("unattributed and non-participant actors cannot originate LIFE activity", () => {
	const root = mkdtempSync(join(tmpdir(), "lina-activity-auth-"));
	const { resources, activities } = open(root);
	try {
		const doc = seed(resources);
		expect(() =>
			activities.create(sharedOnly, recorded("act-1", doc.id)),
		).toThrow(/unattributed/);
		expect(() =>
			activities.create(
				a,
				recorded("act-1", doc.id, {
					actorAgentId: "z",
					participantAgentIds: ["z"],
				}),
			),
		).toThrow(/host-verified|participant/);
		expect(() =>
			activities.create(
				a,
				recorded("act-1", doc.id, { participantAgentIds: ["b"] }),
			),
		).toThrow(/participant/);
	} finally {
		activities.close();
		resources.close();
		rmSync(root, { recursive: true, force: true });
	}
});

test("verified_result requires host confirmation and an actual source quote", () => {
	const root = mkdtempSync(join(tmpdir(), "lina-activity-verify-"));
	const { resources, activities } = open(root);
	try {
		const doc = seed(resources);
		expect(() =>
			activities.create(
				a,
				recorded("act-1", doc.id, {
					outcome: "verified_result",
					hostConfirmed: false,
					quotes: ["because it is portable"],
					fields: { ...fields, outcome: "verified_result" },
				}),
			),
		).toThrow(/host confirmation/);
		expect(() =>
			activities.create(
				a,
				recorded("act-1", doc.id, {
					outcome: "verified_result",
					hostConfirmed: true,
					quotes: [],
					fields: { ...fields, outcome: "verified_result" },
				}),
			),
		).toThrow(/quote/);
		expect(() =>
			activities.create(
				a,
				recorded("act-1", doc.id, {
					outcome: "verified_result",
					hostConfirmed: true,
					quotes: ["not in the document"],
					fields: { ...fields, outcome: "verified_result" },
				}),
			),
		).toThrow(/quote/);
		const created = activities.create(
			a,
			recorded("act-1", doc.id, {
				outcome: "verified_result",
				hostConfirmed: true,
				quotes: ["because it is portable"],
				fields: { ...fields, outcome: "verified_result" },
			}),
		);
		expect(created.receipt.outcome).toBe("verified_result");
		expect(created.receipt.evidenceDigest).not.toBe(lifeDigest([]));
		expect("taskId" in created.receipt).toBe(false);
	} finally {
		activities.close();
		resources.close();
		rmSync(root, { recursive: true, force: true });
	}
});

test("create, replay, CAS, reopen and grant restrict stay contiguous", () => {
	const root = mkdtempSync(join(tmpdir(), "lina-activity-cas-"));
	let { resources, activities } = open(root);
	try {
		const doc = seed(resources);
		const input = recorded("act-1", doc.id);
		const created = activities.create(a, input);
		expect(activities.create(a, input)).toEqual(created);
		expect(() =>
			activities.create(a, { ...input, quotes: ["We chose paper"] }),
		).toThrow(/conflict/);
		const pending = activities.pending(a, "world-1");
		expect(pending).toHaveLength(1);
		const source = parseResourceActivitySource(pending[0]?.source);
		expect(source.kind).toBe("resource_activity");
		expect(source.operation).toBe("upsert");
		expect(source.receipt.supersedesRevision).toBeNull();
		activities.ack(a, {
			operationId: "ack-1",
			deliveryId: source.deliveryId,
			sourceDigest: source.sourceDigest,
		});
		expect(
			activities.ack(a, {
				operationId: "ack-1",
				deliveryId: source.deliveryId,
				sourceDigest: source.sourceDigest,
			}).state,
		).toBe("acknowledged");
		const corrected = activities.correct(a, {
			operationId: "fix-1",
			activityId: "act-1",
			expectedRevision: 1,
			outcome: "recorded",
			memoryId: null,
			quotes: [],
			hostConfirmed: false,
			fields,
			policyRevision: 1,
			correction: { kind: "amend", reason: "clarify" },
		});
		expect(corrected.receipt.activityRevision).toBe(2);
		expect(corrected.receipt.supersedesRevision).toBe(1);
		expect(() =>
			activities.correct(a, {
				operationId: "stale",
				activityId: "act-1",
				expectedRevision: 1,
				outcome: "recorded",
				memoryId: null,
				quotes: [],
				hostConfirmed: false,
				fields,
				policyRevision: 1,
				correction: { kind: "amend", reason: "late" },
			}),
		).toThrow(/stale/);
		const restricted = activities.restrict(a, {
			operationId: "rev-1",
			activityId: "act-1",
			expectedRevision: 2,
			worldId: "world-1",
			policyRevision: 1,
		});
		expect(restricted.grant.revoked).toBe(true);
		expect(restricted.receipt.activityRevision).toBe(3);
		const restrictPending = activities.pending(a, "world-1");
		expect(restrictPending[0]?.source.operation).toBe("restrict");
		expect(restrictPending[0]?.source.fields).toBeNull();
		activities.close();
		resources.close();
		({ resources, activities } = open(root));
		const reopened = activities.get(a, "act-1");
		expect(reopened.receipt.activityRevision).toBe(3);
		expect(reopened.grant.revoked).toBe(true);
		const granted = activities.grant(a, {
			operationId: "grant-2",
			activityId: "act-1",
			expectedRevision: 3,
			worldId: "world-1",
			fields,
			policyRevision: 2,
		});
		expect(granted.grant.revoked).toBe(false);
		expect(granted.receipt.grantRevision).toBe(
			restricted.receipt.grantRevision + 1,
		);
	} finally {
		activities.close();
		resources.close();
		rmSync(root, { recursive: true, force: true });
	}
});

test("private scope is rejected and source-stale pending grants are restricted", () => {
	const root = mkdtempSync(join(tmpdir(), "lina-activity-stale-"));
	const { resources, activities } = open(root);
	try {
		const privateDoc = seed(resources, "private", "priv");
		expect(() =>
			activities.create(b, recorded("act-p", privateDoc.id)),
		).toThrow(/host-verified|unavailable|owner/);
		const doc = seed(resources, "shared", "shared-doc");
		const created = activities.create(a, recorded("act-1", doc.id));
		const before = activities.pending(a, "world-1");
		expect(before[0]?.source.operation).toBe("upsert");
		const oldDelivery = before[0]?.source;
		if (!oldDelivery) throw Error("missing delivery");
		resources.update(a, {
			operationId: "edit",
			id: doc.id,
			expectedRevision: doc.revision,
			bytes: text("The decision changed."),
		});
		expect(() =>
			activities.ack(a, {
				operationId: "ack-stale",
				deliveryId: oldDelivery.deliveryId,
				sourceDigest: oldDelivery.sourceDigest,
			}),
		).toThrow(/stale|unavailable/);
		const after = activities.pending(a, "world-1");
		expect(after[0]?.source.operation).toBe("restrict");
		expect(activities.get(a, created.receipt.activityId).grant.revoked).toBe(
			true,
		);
	} finally {
		activities.close();
		resources.close();
		rmSync(root, { recursive: true, force: true });
	}
});

for (const [label, sql] of [
	["unknown schema", "PRAGMA user_version=9"],
	["extra table", "CREATE TABLE foreign_data(id INTEGER)"],
	["json", "UPDATE resource_activities SET data='{}'"],
	["column identity", "UPDATE resource_activities SET actor_agent_id='forged'"],
	["history gap", "DELETE FROM resource_activity_operations"],
	[
		"unknown revision",
		"UPDATE resource_activity_deliveries SET activity_revision=99",
	],
] as const)
	test(`reopen refuses corrupt ${label} without rewriting it`, () => {
		const root = mkdtempSync(join(tmpdir(), "lina-activity-corrupt-"));
		try {
			const first = open(root);
			const doc = seed(first.resources);
			first.activities.create(a, recorded("act-1", doc.id));
			first.activities.close();
			first.resources.close();
			const db = new DatabaseSync(join(root, "activities.sqlite"));
			try {
				db.exec(sql);
				const before = db
					.prepare("SELECT * FROM resource_activity_operations")
					.all();
				const resources = new ResourceStore(root, limits);
				try {
					expect(() => new ResourceActivities(root, resources, host)).toThrow();
				} finally {
					resources.close();
				}
				expect(
					db.prepare("SELECT * FROM resource_activity_operations").all(),
				).toEqual(before);
			} finally {
				db.close();
			}
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

test("host-side evidence digest matches stored quotes", () => {
	const root = mkdtempSync(join(tmpdir(), "lina-activity-digest-"));
	const { resources, activities } = open(root);
	try {
		const doc = seed(resources);
		const created = activities.create(
			a,
			recorded("act-1", doc.id, {
				outcome: "verified_result",
				hostConfirmed: true,
				quotes: ["because it is portable"],
				fields: { ...fields, outcome: "verified_result" },
			}),
		);
		const quote = created.snapshot.quotes[0];
		if (!quote) throw Error("missing quote");
		expect(quote.quoteHash).toBe(hash(quote.quote));
		expect(created.receipt.evidenceDigest).toBe(
			lifeDigest([
				{
					resourceId: created.snapshot.resourceId,
					resourceRevision: created.snapshot.resourceRevision,
					versionId: created.snapshot.versionId,
					blobHash: created.snapshot.blobHash,
					quote: quote.quote,
					quoteHash: quote.quoteHash,
					memoryId: quote.memoryId,
				},
			]),
		);
	} finally {
		activities.close();
		resources.close();
		rmSync(root, { recursive: true, force: true });
	}
});

test("restrict while pending withholds the prepared upsert", () => {
	const root = mkdtempSync(join(tmpdir(), "lina-activity-revoke-"));
	const { resources, activities } = open(root);
	try {
		const doc = seed(resources);
		activities.create(a, recorded("act-1", doc.id));
		const prepared = activities.pending(a, "world-1")[0]?.source;
		if (!prepared) throw Error("missing prepared delivery");
		activities.restrict(a, {
			operationId: "rev-pending",
			activityId: "act-1",
			expectedRevision: 1,
			worldId: "world-1",
			policyRevision: 1,
		});
		expect(() =>
			activities.ack(a, {
				operationId: "ack-old",
				deliveryId: prepared.deliveryId,
				sourceDigest: prepared.sourceDigest,
			}),
		).toThrow(/unavailable|stale/);
		const next = activities.pending(a, "world-1");
		expect(next).toHaveLength(1);
		expect(next[0]?.source.operation).toBe("restrict");
	} finally {
		activities.close();
		resources.close();
		rmSync(root, { recursive: true, force: true });
	}
});

test("unknown memory ids are rejected", () => {
	const root = mkdtempSync(join(tmpdir(), "lina-activity-memory-"));
	const { resources, activities } = open(root);
	try {
		const doc = seed(resources);
		expect(() =>
			activities.create(
				a,
				recorded("act-1", doc.id, {
					memoryId: "00000000-0000-4000-8000-000000000000",
				}),
			),
		).toThrow(/memory/);
	} finally {
		activities.close();
		resources.close();
		rmSync(root, { recursive: true, force: true });
	}
});

test("verified_result can bind a current resource memory and rejects it after source change", () => {
	const root = mkdtempSync(join(tmpdir(), "lina-activity-mem-bind-"));
	const { resources, activities } = open(root);
	try {
		const doc = resources.create(a, {
			operationId: "doc-mem",
			kind: "document",
			title: "조사",
			visibility: "shared",
			mediaType: "text/plain",
			bytes: text("We chose paper because it is portable."),
			deriveMemory: true,
			activityKind: "research",
		});
		const job = resources.memories.jobs(a, doc.id)[0];
		if (!job) throw Error("missing capture job");
		const claim = resources.memories.prepare(
			a,
			job.id,
			"We chose paper because it is portable.",
		);
		const memories = resources.memories.complete(a, claim, [
			{
				kind: "decision",
				text: "Paper was selected for portability.",
				quote: "because it is portable",
			},
		]);
		const memoryId = memories[0]?.id;
		if (!memoryId) throw Error("missing memory");
		const created = activities.create(
			a,
			recorded("act-mem", doc.id, {
				outcome: "verified_result",
				hostConfirmed: true,
				quotes: ["because it is portable"],
				memoryId,
				fields: { ...fields, outcome: "verified_result" },
			}),
		);
		expect(created.receipt.memoryId).toBe(memoryId);
		resources.update(a, {
			operationId: "rewrite",
			id: doc.id,
			expectedRevision: doc.revision,
			bytes: text("The decision changed."),
		});
		const after = activities.pending(a, "world-1");
		expect(after[0]?.source.operation).toBe("restrict");
	} finally {
		activities.close();
		resources.close();
		rmSync(root, { recursive: true, force: true });
	}
});

test("delivery authority is checked again after acknowledgement and restriction", () => {
	const root = mkdtempSync(join(tmpdir(), "lina-activity-current-"));
	const { resources, activities } = open(root);
	try {
		const doc = seed(resources);
		activities.create(a, recorded("act-1", doc.id));
		const source = activities.pending(a, "world-1")[0]?.source;
		if (!source) throw Error("Missing delivery");
		expect(activities.current(a, "world-1", source)).toBe(true);
		expect(activities.current(a, "other-world", source)).toBe(false);
		expect(
			activities.current(a, "world-1", {
				...source,
				fields: { ...fields, summary: "forged" },
			}),
		).toBe(false);
		activities.ack(a, {
			operationId: "ack-1",
			deliveryId: source.deliveryId,
			sourceDigest: source.sourceDigest,
		});
		expect(activities.current(a, "world-1", source)).toBe(true);
		activities.restrict(a, {
			operationId: "restrict-1",
			activityId: "act-1",
			expectedRevision: 1,
			worldId: "world-1",
			policyRevision: 2,
		});
		expect(activities.current(a, "world-1", source)).toBe(false);
		const restricted = activities.pending(a, "world-1")[0]?.source;
		if (!restricted) throw Error("Missing restriction");
		expect(activities.current(a, "world-1", restricted)).toBe(true);
	} finally {
		activities.close();
		resources.close();
		rmSync(root, { recursive: true, force: true });
	}
});

test("acknowledged activity emits one restriction when its source changes", () => {
	const root = mkdtempSync(join(tmpdir(), "lina-activity-ack-stale-"));
	const { resources, activities } = open(root);
	try {
		const doc = seed(resources);
		activities.create(a, recorded("activity", doc.id));
		const source = activities.pending(a, "world-1")[0]?.source;
		if (!source) throw Error("Missing source");
		activities.ack(a, {
			operationId: "ack",
			deliveryId: source.deliveryId,
			sourceDigest: source.sourceDigest,
		});
		resources.update(a, {
			operationId: "rewrite",
			id: doc.id,
			expectedRevision: doc.revision,
			bytes: text("Changed source"),
		});
		expect(activities.current(a, "world-1", source)).toBe(false);
		const deliveries = activities.pending(a, "world-1");
		expect(deliveries).toHaveLength(1);
		expect(deliveries[0]?.source.operation).toBe("restrict");
		expect(activities.pending(a, "world-1")).toEqual(deliveries);
	} finally {
		activities.close();
		resources.close();
		rmSync(root, { recursive: true, force: true });
	}
});

test("verified_result quotes derived HTML extract and stays current until source change", async () => {
	const root = mkdtempSync(join(tmpdir(), "lina-activity-html-"));
	const { resources, activities } = open(root);
	const original = text(
		'<html><head><style/>.secret { color: red }</style><script/>secret("B")</script></head><body><p>Hello &amp; welcome</p></body></html>',
	);
	try {
		const doc = resources.create(a, {
			operationId: "html",
			kind: "document",
			title: "HTML 조사",
			visibility: "shared",
			mediaType: "text/html",
			bytes: original,
		});
		const extracted = await extractResource(
			resources,
			() => a,
			doc.id,
			new AbortController().signal,
		);
		expect(extracted.status).toBe("ready");
		if (extracted.status !== "ready") throw Error("html extract unavailable");
		expect(extracted.text).toContain("Hello & welcome");
		expect(extracted.text).not.toContain('secret("B")');
		expect(extracted.text).not.toContain("color: red");
		const job = resources.indexing
			.list(a, doc.id)
			.find((item) => item.kind === "extract");
		if (!job) throw Error("missing extract job");
		resources.indexing.complete(
			a,
			resources.indexing.prepare(a, job.id),
			extracted.text,
			extracted.complete,
		);
		expect(() =>
			activities.create(
				a,
				recorded("act-html", doc.id, {
					outcome: "verified_result",
					hostConfirmed: true,
					quotes: ['secret("B")'],
					fields: { ...fields, outcome: "verified_result" },
				}),
			),
		).toThrow(/quote/);
		expect(() =>
			activities.create(
				a,
				recorded("act-html-style", doc.id, {
					outcome: "verified_result",
					hostConfirmed: true,
					quotes: ["color: red"],
					fields: { ...fields, outcome: "verified_result" },
				}),
			),
		).toThrow(/quote/);
		const created = activities.create(
			a,
			recorded("act-html", doc.id, {
				outcome: "verified_result",
				hostConfirmed: true,
				quotes: ["Hello & welcome"],
				fields: { ...fields, outcome: "verified_result" },
			}),
		);
		expect(created.receipt.outcome).toBe("verified_result");
		const pending = activities.pending(a, "world-1")[0]?.source;
		if (!pending) throw Error("missing delivery");
		expect(activities.current(a, "world-1", pending)).toBe(true);
		expect(resources.read(a, doc.id).bytes).toEqual(original);
		resources.update(a, {
			operationId: "rewrite-html",
			id: doc.id,
			expectedRevision: doc.revision,
			bytes: text("<p>Changed source</p>"),
		});
		expect(activities.current(a, "world-1", pending)).toBe(false);
		expect(() =>
			activities.create(
				a,
				recorded("act-html-stale", doc.id, {
					operationId: "create-html-stale",
					outcome: "verified_result",
					hostConfirmed: true,
					quotes: ["Hello & welcome"],
					fields: { ...fields, outcome: "verified_result" },
				}),
			),
		).toThrow(/quote/);
	} finally {
		activities.close();
		resources.close();
		rmSync(root, { recursive: true, force: true });
	}
});
