import { expect, test } from "bun:test";
import { DatabaseSync } from "node:sqlite";
import {
	type IntentionRecord,
	intentionDigest,
	JudgmentStore,
	parseIntentionRecord,
	resolvePersonalRound,
	transitionIntention,
} from "../src/agents/index.ts";
import { canonicalJson } from "../src/agents/judgment-validation.ts";
import {
	policyEvidenceFixture,
	policyOption,
} from "./judgment-policy-evidence-fixture.ts";

const paths = {
	adopted: [],
	active: ["active"],
	suspended: ["active", "suspended"],
} as const;

function advance(
	f: ReturnType<typeof policyEvidenceFixture>,
	status: keyof typeof paths,
): IntentionRecord {
	let source = f.adopted;
	for (const to of paths[status])
		source = f.store.transitionIntention(
			source.intentionId,
			{
				to,
				reason: "prepare lifecycle",
				evidenceRef: source.acceptance.sourceRef,
				at: source.acceptance.acceptedAt,
			},
			source.revision,
		);
	return source;
}

function cancellation(source: IntentionRecord) {
	return {
		to: "cancelled" as const,
		reason: "new interest without a cancellation request",
		evidenceRef: source.acceptance.sourceRef,
		at: source.acceptance.acceptedAt,
	};
}

for (const status of ["adopted", "active", "suspended"] as const) {
	for (const boundary of ["helper", "store"] as const)
		test(`3999164940 ${boundary} rejects acceptance-only cancellation from ${status}`, () => {
			const f = policyEvidenceFixture();
			try {
				const source = advance(f, status);
				const before = structuredClone(source);
				const revision = f.store.intentionRevision(
					source.agentId,
					source.scopeId,
				);
				expect(() =>
					boundary === "helper"
						? transitionIntention(source, cancellation(source))
						: f.store.transitionIntention(
								source.intentionId,
								cancellation(source),
								source.revision,
							),
				).toThrow("user commitment cancellation authority is unavailable");
				expect(source).toEqual(before);
				const reopened = f.fixture.keep(new JudgmentStore(f.path));
				expect(reopened.getIntention(source.intentionId)).toEqual(before);
				expect(reopened.intentionRevision(source.agentId, source.scopeId)).toBe(
					revision,
				);
			} finally {
				f.fixture.close();
			}
		});

	test(`3999164940 historical cancellation from ${status} remains readable but cannot be inserted`, () => {
		const f = policyEvidenceFixture();
		try {
			const source = advance(f, status);
			const historical: IntentionRecord = {
				...source,
				status: "cancelled",
				revision: source.revision + 1,
				history: [
					...source.history,
					{ ...cancellation(source), from: source.status },
				],
			};
			expect(parseIntentionRecord(historical)).toEqual(historical);
			expect(() => f.store.putIntention(historical)).toThrow(
				"intention must be proposed",
			);
			// Reconstruct a pre-authority F1 ledger, not a newly authorized command.
			const db = new DatabaseSync(f.path);
			try {
				db.prepare(
					"UPDATE intention_records SET revision = ?, status = ?, digest = ?, body = ? WHERE intention_id = ?",
				).run(
					historical.revision,
					historical.status,
					intentionDigest(historical),
					canonicalJson(historical),
					historical.intentionId,
				);
				db.prepare(
					"INSERT INTO intention_transitions(intention_id, revision, from_status, to_status, reason, evidence_ref, at) VALUES (?, ?, ?, ?, ?, ?, ?)",
				).run(
					source.intentionId,
					historical.revision,
					source.status,
					"cancelled",
					cancellation(source).reason,
					source.acceptance.sourceRef,
					source.acceptance.acceptedAt,
				);
			} finally {
				db.close();
			}
			const reopened = f.fixture.keep(new JudgmentStore(f.path));
			expect(reopened.getIntention(source.intentionId)).toEqual(historical);
			expect(() =>
				reopened.transitionIntention(
					source.intentionId,
					{
						...cancellation(source),
						to: "active",
					},
					historical.revision,
				),
			).toThrow("invalid intention transition: cancelled -> active");
		} finally {
			f.fixture.close();
		}
	});

	for (const kind of ["autonomous_goal", "task_binding"] as const)
		test(`3999164940 ${kind} cancellation from ${status} retains the existing lifecycle`, () => {
			const f = policyEvidenceFixture();
			try {
				const source = { ...advance(f, status), kind };
				const result = transitionIntention(source, cancellation(source));
				expect(parseIntentionRecord(result).status).toBe("cancelled");
				expect(result.acceptance).toEqual(source.acceptance);
			} finally {
				f.fixture.close();
			}
		});
}

test("3999164940 proposed user commitment withdrawal still persists and reopens", () => {
	const f = policyEvidenceFixture();
	try {
		const source: IntentionRecord = {
			...f.adopted,
			intentionId: "proposal",
			revision: 0,
			status: "proposed",
			history: [],
		};
		f.store.putIntention(source);
		const result = f.store.transitionIntention(
			source.intentionId,
			cancellation(source),
			0,
		);
		expect(result.status).toBe("cancelled");
		const reopened = f.fixture.keep(new JudgmentStore(f.path));
		expect(reopened.getIntention(source.intentionId)).toEqual(result);
	} finally {
		f.fixture.close();
	}
});

test("3999164940 ranking and receipt-shaped catalog strings cannot authorize cancellation", () => {
	const f = policyEvidenceFixture(policyOption("intention.cancel"));
	try {
		f.oppose("atropos", ["promise"]);
		const result = resolvePersonalRound(f.input);
		expect(result.resolution.status).toBe("resolved");
		expect(() =>
			f.store.transitionIntention("promise", cancellation(f.adopted), 1),
		).toThrow("user commitment cancellation authority is unavailable");
	} finally {
		f.fixture.close();
	}
});

for (const field of ["authorityRef", "userConfirmationRef", "authorized"])
	test(`3999164940 caller-controlled ${field} cannot unlock cancellation`, () => {
		const f = policyEvidenceFixture();
		try {
			const input = {
				...cancellation(f.adopted),
				[field]: "claimed-authority",
			};
			expect(() => transitionIntention(f.adopted, input)).toThrow(
				"invalid intention transition",
			);
			expect(() => f.store.transitionIntention("promise", input, 1)).toThrow(
				`unknown intention transition field ${field}`,
			);
		} finally {
			f.fixture.close();
		}
	});
