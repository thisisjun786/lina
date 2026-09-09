import { expect, test } from "bun:test";
import { evaluateWorld } from "../src/world/authoring.ts";
import {
	authoringPack,
	evaluation,
	literal,
	loreEntry,
	read,
	rule,
} from "./life-authoring-fixture.ts";
import { required } from "./life-fixture.ts";

test("Unicode normalized exact contiguous token phrases and explicit secondary modes", () => {
	const p = authoringPack();
	p.lore = [
		loreEntry("phrase", {
			primaryKeys: ["CAFÉ 서울"],
			secondaryKeys: ["blue", "bell"],
			secondaryMode: "all",
		}),
	];
	for (const text of ["cafe\u0301 서울 BLUE bell", "ＣＡＦÉ, 서울! blue bell"])
		expect(
			evaluateWorld(p, evaluation({ text })).entries.map((e) => e.id),
		).toEqual(["phrase"]);
	for (const text of [
		"café extra 서울 blue bell",
		"xcafé 서울 blue bell",
		"café 서울 blue",
		"café 서울ish blue bell",
	])
		expect(evaluateWorld(p, evaluation({ text })).entries).toEqual([]);
	required(p.lore[0]).secondaryMode = "any";
	expect(
		evaluateWorld(p, evaluation({ text: "café 서울 blue" })).entries,
	).toHaveLength(1);
});
test("actor and recipient filtering precedes keys, recursion, draws and budgets", () => {
	const p = authoringPack();
	const visible = loreEntry("public", {
		probability: 0.8,
		disclosure: {
			knowers: ["lina"],
			disclosures: [{ agentId: "lina", recipientId: "reader" }],
			publication: ["reader"],
		},
	});
	p.lore = [visible];
	const input = evaluation({ recipientId: "reader" });
	const baseline = evaluateWorld(p, input);
	p.lore.unshift(
		loreEntry("hidden", {
			always: true,
			probability: 0.5,
			priority: 99,
			text: [{ kind: "text", text: "bell".repeat(100) }],
			disclosure: { knowers: ["sol"], disclosures: [], publication: [] },
		}),
	);
	p.lore.push(loreEntry("unpublished", { always: true, probability: 0.5 }));
	expect(evaluateWorld(p, input)).toEqual(baseline);
	expect(
		evaluateWorld(p, evaluation({ recipientId: "other", text: "bell" }))
			.entries,
	).toEqual([]);
});
for (const rejected of ["condition", "probability"] as const)
	test(`rejected ${rejected} A cannot recursively activate B or create effects`, () => {
		const p = authoringPack();
		p.lore = [
			loreEntry("A", {
				always: true,
				condition: literal(rejected !== "condition"),
				probability: rejected === "probability" ? 0 : 1,
				text: [{ kind: "text", text: "activate-b" }],
			}),
			loreEntry("B", {
				primaryKeys: ["activate-b"],
				effects: [{ kind: "assign", variableId: "flag", value: literal(true) }],
			}),
		];
		const out = evaluateWorld(p, evaluation({ text: "" }));
		expect(out.entries).toEqual([]);
		expect(out.effects).toEqual([]);
		expect(out.variables).toMatchObject({ flag: false });
	});
test("bounded recursion evaluates successful text/random once and preserves stable priority/placement", () => {
	const p = authoringPack();
	p.lore = [
		loreEntry("A", {
			priority: 1,
			text: [
				{ kind: "text", text: "beta " },
				{
					kind: "value",
					expression: { op: "random", id: "text", min: 0, max: 1 },
				},
			],
		}),
		loreEntry("B", {
			primaryKeys: ["beta"],
			priority: 2,
			placement: "before",
			text: [{ kind: "text", text: "bell gamma" }],
		}),
		loreEntry("C", { primaryKeys: ["gamma"] }),
	];
	const out = evaluateWorld(p, evaluation());
	expect(out.entries.map((e) => e.id)).toEqual(["B", "A", "C"]);
	expect(out.draws.filter((d) => d.id.includes("text"))).toHaveLength(1);
	expect(new Set(out.draws.map((d) => d.id)).size).toBe(out.draws.length);
	const shallow = evaluateWorld(
		p,
		evaluation({ limits: { ...evaluation().limits, maxDepth: 0 } }),
	);
	expect(shallow.entries.map((e) => e.id)).toEqual(["A"]);
	expect(shallow.truncated).toBe(true);
	expect(evaluateWorld(p, evaluation())).toEqual(out);
});
test("whole-record budget drops setter effects and all conditions read immutable input", () => {
	const p = authoringPack();
	p.lore = [
		loreEntry("setter", {
			priority: 100,
			text: [{ kind: "text", text: "x".repeat(6000) }],
			effects: [{ kind: "assign", variableId: "flag", value: literal(true) }],
		}),
		loreEntry("dependent", { condition: read("flag") }),
		loreEntry("retained", {
			priority: 1,
			text: [{ kind: "text", text: "Fits" }],
		}),
	];
	p.rules = [rule("later", { condition: read("flag") })];
	const input = evaluation({
		limits: { ...evaluation().limits, maxChars: 1800 },
	});
	const out = evaluateWorld(p, input);
	expect(out.entries.map((e) => e.id)).toEqual(["retained"]);
	expect(out.effects).toEqual([]);
	expect(out.ruleIds).toEqual([]);
	expect(out.variables).toMatchObject({ flag: false });
	expect(out.truncated).toBe(true);
	expect(JSON.stringify(out).length).toBeLessThanOrEqual(1800);
	const retainedSetter = evaluateWorld(p, evaluation());
	expect(retainedSetter.variables).toMatchObject({ flag: true });
	expect(retainedSetter.entries.map((e) => e.id)).not.toContain("dependent");
	expect(retainedSetter.ruleIds).toEqual([]);
});
test("only caller-owned perception can seed keys; authored source, reports and raw world lore cannot", () => {
	const p = authoringPack();
	p.background.authoredText = "bell";
	required(p.world.lore[0]).text = "bell";
	p.importReport = [
		{ sourceId: "script", reason: "unsupported", rawJson: '"bell"' },
	];
	p.lore = [loreEntry("public")];
	expect(evaluateWorld(p, evaluation({ text: "" })).entries).toEqual([]);
	expect(
		evaluateWorld(p, evaluation({ text: "bell" })).entries.map((e) => e.id),
	).toEqual(["public"]);
});

test("record count zero and exact character limits discard records atomically", () => {
	const p = authoringPack();
	p.lore = [
		loreEntry("a", {
			effects: [{ kind: "assign", variableId: "flag", value: literal(true) }],
		}),
	];
	const full = evaluateWorld(p, evaluation());
	const exact = evaluateWorld(
		p,
		evaluation({
			limits: { ...evaluation().limits, maxChars: JSON.stringify(full).length },
		}),
	);
	expect(exact.entries).toHaveLength(1);
	const short = evaluateWorld(
		p,
		evaluation({
			limits: {
				...evaluation().limits,
				maxChars: JSON.stringify(full).length - 1,
			},
		}),
	);
	expect(short.entries).toEqual([]);
	expect(short.effects).toEqual([]);
	expect(short.variables).toMatchObject({ flag: false });
	const zero = evaluateWorld(
		p,
		evaluation({ limits: { ...evaluation().limits, maxRecords: 0 } }),
	);
	expect(zero.entries).toEqual([]);
	expect(zero.effects).toEqual([]);
	expect(zero.truncated).toBe(true);
});

test("equal priority uses stable IDs and denied actor data consumes zero operations", () => {
	const p = authoringPack();
	p.lore = [loreEntry("b", { always: true }), loreEntry("a", { always: true })];
	const full = evaluateWorld(p, evaluation());
	expect(full.entries.map((e) => e.id)).toEqual(["a", "b"]);
	p.lore.reverse();
	expect(evaluateWorld(p, evaluation())).toEqual(full);
	const input = evaluation({
		limits: { ...evaluation().limits, maxOperations: 6 },
	});
	const baseline = evaluateWorld(p, input);
	p.lore.unshift(
		loreEntry("hidden", {
			always: true,
			disclosure: { knowers: ["sol"], disclosures: [], publication: [] },
			text: [
				{
					kind: "value",
					expression: { op: "random", id: "expensive", min: 0, max: 1 },
				},
			],
		}),
	);
	expect(evaluateWorld(p, input)).toEqual(baseline);
});

test("expression text expansion stops at the canonical storage ceiling before concatenation", () => {
	const p = authoringPack();
	p.variables.push({
		id: "paragraph",
		type: "string",
		initial: "x".repeat(30000),
		min: null,
		max: null,
		knownTo: ["lina", "mira", "sol"],
	});
	p.lore = [
		loreEntry("expansion", {
			text: Array.from({ length: 40 }, () => ({
				kind: "value",
				expression: read("paragraph"),
			})),
		}),
	];
	expect(() =>
		evaluateWorld(
			p,
			evaluation({ limits: { ...evaluation().limits, maxChars: 1000000 } }),
		),
	).toThrow("Authoring rendered text capacity exceeded");
});
