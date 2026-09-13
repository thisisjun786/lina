import { expect, test } from "bun:test";
import {
	buildCanonicalOption,
	type CanonicalOption,
	canonicalOptionKey,
	normalizeOptionArgs,
	PERSONAL_OPTION_KINDS,
	type PersonalOptionKind,
	type PersonalPrecondition,
	parseCanonicalOption,
} from "../src/agents/index.ts";

const preconditions = [
	{
		kind: "intention.adopt",
		intentionKind: "user_commitment",
		sourceRef: "source",
	},
	{ kind: "intention.activate", intentionId: "intention" },
	{
		kind: "intention.suspend",
		intentionId: "intention",
		acceptanceSourceRef: "acceptance",
		reason: "pause work",
	},
	{
		kind: "intention.resume",
		intentionId: "intention",
		acceptanceSourceRef: "acceptance",
		reason: "resume work",
	},
	{
		kind: "intention.cancel",
		intentionId: "intention",
		acceptanceSourceRef: "acceptance",
		authorityRef: "authority",
		userConfirmationRef: null,
	},
	{
		kind: "intention.complete",
		intentionId: "intention",
		outcomeRef: "outcome",
	},
	{
		kind: "task.start",
		authorityRef: "authority",
		taskText: "perform work",
		intentionId: "intention",
	},
	{ kind: "task.send", taskId: "task", ownerId: "owner", revision: 1 },
	{ kind: "task.interrupt", taskId: "task", ownerId: "owner", revision: 1 },
	{ kind: "task.handover", taskId: "task", ownerId: "owner", revision: 1 },
	{ kind: "inquire", authorityRef: "authority" },
	{ kind: "defer", resumeCondition: "input arrives" },
	{ kind: "noop", reason: "nothing needed" },
] satisfies PersonalPrecondition[];

function option(precondition: PersonalPrecondition): CanonicalOption {
	return buildCanonicalOption({
		kind: precondition.kind,
		actor: { agentId: "agent", scopeId: "scope" },
		targetId: "target",
		args: {},
		preconditions: precondition,
	});
}

for (const [label, value] of [
	["spaces", " ".repeat(1001)],
	["tabs", "\t".repeat(1001)],
] as const) {
	const original = option({ kind: "noop", reason: "nothing needed" });
	const changed = { ...original, args: { empty: value } };
	const operations = {
		normalize: () => normalizeOptionArgs(changed.args),
		key: () => canonicalOptionKey(changed),
		build: () => buildCanonicalOption(changed),
		parse: () => parseCanonicalOption(changed),
	};
	for (const [operation, run] of Object.entries(operations))
		test(`3999091818 ${operation} rejects oversized ${label} before omission`, () => {
			expect(run).toThrow("invalid option argument");
		});
}

test("3999091818 bounded empty arguments are omitted while the full text ceiling survives", () => {
	expect(
		normalizeOptionArgs({
			empty: "",
			spaces: " ".repeat(1000),
			tabs: "\t".repeat(1000),
			text: "x".repeat(1000),
		}),
	).toEqual({ text: "x".repeat(1000) });
});

test("identity fixtures cover every personal option kind", () => {
	expect(preconditions.map((p) => p.kind)).toEqual([...PERSONAL_OPTION_KINDS]);
});

for (const precondition of preconditions) {
	for (const length of [100, 160]) {
		test(`${precondition.kind} round-trips a ${length}-character target with a bounded key`, () => {
			const original = option(precondition);
			const targetId = "x".repeat(length);
			const built = buildCanonicalOption({ ...original, targetId });
			expect(built.targetId).toBe(targetId);
			expect(built.optionKey.length).toBeLessThanOrEqual(160);
			expect(built.optionKey.length).toBe(original.optionKey.length);
			expect(parseCanonicalOption(JSON.parse(JSON.stringify(built)))).toEqual(
				built,
			);
			const changed = buildCanonicalOption({
				...built,
				targetId: `${targetId.slice(0, -1)}y`,
			});
			expect(changed.optionKey).not.toBe(built.optionKey);
			expect(() =>
				parseCanonicalOption({ ...changed, optionKey: built.optionKey }),
			).toThrow("canonical option key mismatch");
		});
	}

	for (const [field, value] of Object.entries(precondition)) {
		if (field === "kind") continue;
		test(`${precondition.kind} identity binds preconditions.${field}`, () => {
			const original = option(precondition);
			const changedValue =
				field === "intentionKind"
					? "autonomous_goal"
					: typeof value === "number"
						? value + 1
						: `${value ?? "confirmation"}-changed`;
			const changed = buildCanonicalOption({
				...original,
				preconditions: { ...precondition, [field]: changedValue },
			});
			expect(changed.optionKey).not.toBe(original.optionKey);
			expect(parseCanonicalOption(changed)).toEqual(changed);
			expect(() =>
				parseCanonicalOption({ ...changed, optionKey: original.optionKey }),
			).toThrow();
		});
	}

	test(`${precondition.kind} keys preserve normalized equivalence and ignore insertion order`, () => {
		const original = buildCanonicalOption({
			...option(precondition),
			args: { a: "\u00e9 x", z: "last" },
		});
		const reordered = {
			...original,
			kind: original.kind.toUpperCase() as PersonalOptionKind,
			targetId: " target ",
			actor: { scopeId: "scope", agentId: "agent" },
			args: { z: " last ", empty: " \t ", a: " e\u0301   x " },
			preconditions: Object.fromEntries(
				Object.entries(precondition).reverse(),
			) as PersonalPrecondition,
			effect: { scope: "scope", owner: original.effect.owner },
		};
		expect(canonicalOptionKey(reordered)).toBe(original.optionKey);
		expect(buildCanonicalOption(reordered)).toEqual(original);
		expect(parseCanonicalOption(reordered)).toEqual(original);
		expect(
			canonicalOptionKey({
				...original,
				optionKey: "ignored",
			} as CanonicalOption),
		).toBe(original.optionKey);
	});

	test(`${precondition.kind} rejects an effect outside the actor scope even with a new key`, () => {
		const original = option(precondition);
		const changed = {
			...original,
			effect: { ...original.effect, scope: "other-scope" },
		};
		expect(() =>
			parseCanonicalOption({
				...changed,
				optionKey: canonicalOptionKey(changed),
			}),
		).toThrow();
	});
}

for (const field of ["agentId", "scopeId"] as const) {
	test(`identity binds actor.${field}`, () => {
		const original = option({ kind: "noop", reason: "nothing needed" });
		const changed = buildCanonicalOption({
			...original,
			actor: { ...original.actor, [field]: "other" },
		});
		expect(changed.optionKey).not.toBe(original.optionKey);
		expect(() =>
			parseCanonicalOption({ ...changed, optionKey: original.optionKey }),
		).toThrow();
	});
}

for (const effect of [
	{ owner: "host", scope: "scope" },
	{ owner: "none", scope: "other-scope" },
] as const) {
	test(`identity binds effect ${JSON.stringify(effect)}`, () => {
		const original = option({ kind: "noop", reason: "nothing needed" });
		const changed = { ...original, effect };
		expect(canonicalOptionKey(changed)).not.toBe(original.optionKey);
		expect(() =>
			parseCanonicalOption({
				...changed,
				optionKey: canonicalOptionKey(changed),
			}),
		).toThrow();
	});
}

test("bounded keys retain catalog/kind prefix and bind arguments and nullable target", () => {
	const original = option({ kind: "noop", reason: "nothing needed" });
	expect(original.optionKey).toMatch(/^personal\.v1:noop:[a-f0-9]{64}$/);
	const untargeted = buildCanonicalOption({ ...original, targetId: null });
	expect(untargeted.optionKey).toMatch(/^personal\.v1:noop:[a-f0-9]{64}$/);
	expect(untargeted.optionKey).not.toBe(original.optionKey);
	expect(parseCanonicalOption(untargeted)).toEqual(untargeted);
	expect(canonicalOptionKey({ ...original, targetId: "other" })).not.toBe(
		original.optionKey,
	);
	expect(
		canonicalOptionKey({ ...original, args: { text: "different" } }),
	).not.toBe(original.optionKey);
	for (const targetId of [" - ", "x".repeat(161)]) {
		expect(() => canonicalOptionKey({ ...original, targetId })).toThrow();
		expect(() => buildCanonicalOption({ ...original, targetId })).toThrow();
		expect(() => parseCanonicalOption({ ...original, targetId })).toThrow();
	}
});

test("precondition text is not normalized like display arguments", () => {
	const original = option({
		kind: "task.start",
		authorityRef: "authority",
		taskText: "perform work",
		intentionId: "intention",
	});
	const changed = option({
		kind: "task.start",
		authorityRef: "authority",
		taskText: "perform  work",
		intentionId: "intention",
	});
	expect(changed.optionKey).not.toBe(original.optionKey);
});
