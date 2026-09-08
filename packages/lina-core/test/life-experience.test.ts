import { expect, test } from "bun:test";
import {
	bindReflection,
	parseReflectionProposal,
} from "../src/world/experience.ts";
import {
	autonomySource,
	emptyReflection,
} from "./life-autonomy-pure-fixture.ts";
import { required } from "./life-fixture.ts";

test("reflection parser excludes truth authority other actors and disclosure fields", () => {
	const p = emptyReflection();
	p.claims = [{ id: "guess", text: "Perhaps red", supersedes: null }];
	expect(parseReflectionProposal(p)).toEqual(p);
	expect(() => parseReflectionProposal({ ...p, agentId: "mira" })).toThrow();
	expect(() =>
		parseReflectionProposal({
			...p,
			claims: [{ ...p.claims[0], truth: "true" }],
		}),
	).toThrow();
});
test("own unknown claim and wrong belief can be corrected only with owned new evidence", () => {
	const s = autonomySource();
	s.world.revision = 1;
	s.world.simulationTime = 1;
	s.life.revision = 1;
	s.life.worldRevision = 1;
	s.life.experiences = [
		{
			id: "observation",
			agentId: "lina",
			eventId: "test-world:1",
			channel: "direct",
			claims: [],
			simulationTime: 1,
		},
	];
	const p = emptyReflection();
	p.claims = [{ id: "guess", text: "I think red", supersedes: null }];
	p.beliefs = [
		{
			id: "wrong",
			claim: { kind: "life_claim", id: "guess" },
			stance: "believes",
			confidence: "certain",
			experienceIds: ["observation"],
			supersedes: null,
		},
	];
	const result = bindReflection(s, "lina", "step-1", p);
	expect(result.claims[0]).toMatchObject({
		truth: "unknown",
		disclosure: { knowers: ["lina"], disclosures: [], publication: [] },
	});
	expect(required(result.beliefs[0]).agentId).toBe("lina");
	expect(() => bindReflection(s, "mira", "step-1", p)).toThrow(
		/evidence|observation/i,
	);
	s.life.claims.push(...result.claims);
	s.life.beliefs.push(...result.beliefs);
	s.life.experiences.push(...result.experiences);
	s.world.revision = 2;
	s.world.simulationTime = 2;
	s.life.revision = 2;
	s.life.worldRevision = 2;
	s.life.experiences.push({
		id: "correction",
		agentId: "lina",
		eventId: "test-world:2",
		channel: "direct",
		claims: [{ kind: "life_claim", id: "guess" }],
		simulationTime: 2,
	});
	const correction = emptyReflection();
	correction.beliefs = [
		{
			id: "corrected",
			claim: { kind: "life_claim", id: "guess" },
			stance: "disbelieves",
			confidence: "likely",
			experienceIds: ["correction"],
			supersedes: "wrong",
		},
	];
	expect(
		bindReflection(s, "lina", "step-2", correction).beliefs[0],
	).toMatchObject({ supersedes: "wrong", stance: "disbelieves" });
	expect(required(s.life.claims[0]).text).toBe("I think red");
	required(correction.beliefs[0]).experienceIds = ["observation"];
	expect(() => bindReflection(s, "lina", "step-2", correction)).toThrow(
		/evidence/i,
	);
});
