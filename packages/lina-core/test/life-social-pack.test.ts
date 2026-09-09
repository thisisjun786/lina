import { describe, expect, test } from "bun:test";
import { compileSocialPack } from "../src/world/social-compile.ts";
import {
	inspectSocialIntent,
	parseCompiledSocialPack,
	parseSocialDefinition,
} from "../src/world/social-validation.ts";
import { required } from "./life-fixture.ts";
import { socialIntent, socialPack } from "./life-social-pack-fixture.ts";

describe("social compiler boundary", () => {
	test("rejects self-directed references and prototype-sensitive cast IDs", () => {
		const pack = socialPack();
		const terminal = required(pack.social.actions[1]);
		if (terminal.kind !== "terminal") throw Error("fixture");
		required(terminal.effects[0]).second = { kind: "actor" };
		expect(() => compileSocialPack(pack)).toThrow();
		const unsafe = socialPack();
		unsafe.world.agents.push("constructor");
		unsafe.life.participants.push("constructor");
		unsafe.roles.push({
			agentId: "constructor",
			roleId: "resident",
			status: "active",
			description: "Unsafe index key",
		});
		expect(() => compileSocialPack(unsafe)).toThrow();
	});
	test("rejects unknown fields and executable opcodes", () => {
		expect(() =>
			parseSocialDefinition({ ...socialPack().social, engineJson: {} }),
		).toThrow();
		const pack = socialPack();
		Reflect.set(pack.social.actions[1] ?? {}, "effects", [
			{ op: "eval", source: "process.exit()" },
		]);
		expect(() => parseSocialDefinition(pack.social)).toThrow();
	});
	test("produces detached canonical definitions with checked digests", () => {
		const pack = socialPack();
		const compiled = compileSocialPack(pack);
		expect(
			parseCompiledSocialPack(JSON.parse(JSON.stringify(compiled))),
		).toEqual(compiled);
		pack.background.authoredText = "Different scenery";
		expect(compileSocialPack(pack).digest).toBe(compiled.digest);
		required(pack.predicates[0]).initial = 1;
		expect(compiled.predicates.find((p) => p.id === "trust")?.initial).toBe(0);
		expect(() =>
			parseCompiledSocialPack({ ...compiled, ruleDigest: "0".repeat(64) }),
		).toThrow();
	});
	test.each([
		"predicate",
		"direction",
		"role",
		"binding",
		"agent",
		"cycle",
		"resource",
		"mapping",
		"visibility",
	])("rejects invalid %s semantics", (kind) => {
		const pack = socialPack();
		const terminal = required(pack.social.actions[1]);
		if (terminal.kind !== "terminal") throw Error("fixture");
		const effect = required(terminal.effects[0]);
		if (kind === "predicate") effect.predicateId = "missing";
		if (kind === "direction") effect.second = null;
		if (kind === "role")
			terminal.bindings = [{ id: "friend", roleId: "missing", agentId: null }];
		if (kind === "binding")
			effect.first = { kind: "binding", id: "undeclared" };
		if (kind === "agent") effect.first = { kind: "agent", agentId: "missing" };
		if (kind === "cycle") {
			const root = required(pack.social.actions[0]);
			if (root.kind === "root") root.children = ["greet"];
		}
		if (kind === "resource") {
			effect.predicateId = "coins";
			effect.second = null;
		}
		if (kind === "mapping")
			required(pack.predicates[0]).direction = "reciprocal";
		if (kind === "visibility")
			required(pack.social.policies[0]).visibility = {
				kind: "agents",
				agentIds: ["unknown"],
			};
		expect(() => compileSocialPack(pack)).toThrow();
	});
	test("retains concrete agents instead of turning them into unbound roles", () => {
		const pack = socialPack();
		const action = required(pack.social.actions[1]);
		if (action.kind !== "terminal") throw Error("fixture");
		required(action.effects[0]).first = { kind: "agent", agentId: "sol" };
		const compiled = compileSocialPack(pack);
		const output = compiled.definition.actions.find(
			(a) => a.id === "greet-yes",
		);
		expect(output?.kind === "terminal" && output.effects[0]?.first).toEqual({
			kind: "agent",
			agentId: "sol",
		});
	});
	test("accepts composed supported intentions and classifies unknown primitives", () => {
		const pack = compileSocialPack(socialPack());
		const intent = socialIntent();
		intent.primitives.push({
			kind: "transfer",
			predicateId: "coins",
			toAgentId: "mira",
			amount: 2,
		});
		expect(inspectSocialIntent(intent, pack)).toEqual({
			kind: "intent",
			intent,
		});
		const extension = inspectSocialIntent(
			{ ...intent, primitives: [{ kind: "dance", proposal: "Add dancing" }] },
			pack,
		);
		expect(extension.kind).toBe("extension");
		expect(extension.intent.primitives).toEqual([
			{ kind: "extension", primitiveKind: "dance", proposal: "Add dancing" },
		]);
	});
	test.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])(
		"rejects invalid transfer amount %s",
		(amount) => {
			const intent = socialIntent();
			intent.primitives = [
				{ kind: "transfer", predicateId: "coins", toAgentId: "mira", amount },
			];
			expect(() =>
				inspectSocialIntent(intent, compileSocialPack(socialPack())),
			).toThrow();
		},
	);
});
