import { expect, test } from "bun:test";
import { lifeDigest } from "../src/world/life-json.ts";
import { initialLifeState } from "../src/world/life-transition.ts";
import {
	decodeSocialValue,
	encodeSocialValue,
} from "../src/world/social-codec.ts";
import { compileSocialPack } from "../src/world/social-compile.ts";
import { projectSocialActorView } from "../src/world/social-views.ts";
import { initialSnapshot } from "../src/world/transition.ts";
import { required } from "./life-fixture.ts";
import { socialPack } from "./life-social-pack-fixture.ts";
import { checkpointFixture } from "./life-social-validation-fixture.ts";

test("private target attitude cannot change the initiator view or capability menu", () => {
	const pack = socialPack(),
		compiled = compileSocialPack(pack),
		world = initialSnapshot(pack.world);
	const life = initialLifeState(world, pack.life);
	const first = projectSocialActorView(compiled, world, life, "lina", "mira");
	required(
		life.attitudes.find(
			(a) => a.fromAgentId === "mira" && a.toAgentId === "lina",
		),
	).value = -2;
	expect(
		JSON.stringify(
			projectSocialActorView(compiled, world, life, "lina", "mira"),
		),
	).toBe(JSON.stringify(first));
	const target = projectSocialActorView(compiled, world, life, "mira", "lina");
	expect(
		target.values.find(
			(v) => v.predicateId === "trust" && v.secondAgentId === "lina",
		)?.value,
	).toBe(-2);
	expect(
		first.values
			.filter((v) => v.predicateId === "trust")
			.every((v) => v.firstAgentId === "lina"),
	).toBe(true);
	expect(Object.keys(first).sort()).toEqual([
		"agentId",
		"capabilities",
		"values",
	]);
});
test("hidden conditions remain unresolved until resolution and do not gate actor menus", () => {
	const pack = socialPack();
	required(pack.social.capabilities[0]).conditions = [
		{
			predicateId: "trust",
			first: { kind: "target" },
			second: { kind: "actor" },
			operator: ">",
			value: 0,
			window: null,
		},
	];
	const compiled = compileSocialPack(pack),
		world = initialSnapshot(pack.world),
		life = initialLifeState(world, pack.life);
	expect(
		projectSocialActorView(
			compiled,
			world,
			life,
			"lina",
			"mira",
		).capabilities.map((c) => c.id),
	).toEqual(["socialize"]);
	required(required(pack.social.capabilities[0]).conditions[0]).first = {
		kind: "actor",
	};
	required(required(pack.social.capabilities[0]).conditions[0]).second = {
		kind: "target",
	};
	expect(
		projectSocialActorView(compileSocialPack(pack), world, life, "lina", "mira")
			.capabilities,
	).toEqual([]);
});
test("role and explicit knowledge limits apply independently of target private state", () => {
	const pack = socialPack();
	required(pack.social.capabilities[0]).knownTo = ["sol"];
	const compiled = compileSocialPack(pack),
		world = initialSnapshot(pack.world),
		life = initialLifeState(world, pack.life);
	expect(
		projectSocialActorView(compiled, world, life, "lina", "mira").capabilities,
	).toEqual([]);
	expect(() =>
		projectSocialActorView(
			compiled,
			{ ...world, revision: 1 },
			life,
			"lina",
			"mira",
		),
	).toThrow();
});

test("private history values and checkpoint digests do not interfere with actor bytes", () => {
	const pack = socialPack(),
		compiled = compileSocialPack(pack),
		world = initialSnapshot(pack.world),
		life = initialLifeState(world, pack.life);
	world.revision = 1;
	world.simulationTime = 1;
	life.revision = 1;
	life.worldRevision = 1;
	life.checkpoint = checkpointFixture();
	const first = JSON.stringify(
		projectSocialActorView(compiled, world, life, "lina", "mira"),
	);
	const history = decodeSocialValue(
		life.checkpoint.data.state.history,
	) as unknown[][];
	required(history[1]).push({
		category: "p_7472757374",
		type: "value",
		first: "mira",
		second: "lina",
		value: -2,
		id: 5,
		timeHappened: 1,
	});
	life.checkpoint.data.state.history = encodeSocialValue(history);
	life.checkpoint.data.state.iterators["socialRecords"] = 5;
	life.checkpoint.dataDigest = lifeDigest(life.checkpoint.data);
	expect(
		JSON.stringify(
			projectSocialActorView(compiled, world, life, "lina", "mira"),
		),
	).toBe(first);
	expect(
		projectSocialActorView(compiled, world, life, "mira", "lina").values.find(
			(v) => v.predicateId === "trust" && v.secondAgentId === "lina",
		)?.value,
	).toBe(-2);
});

test("new predicates cannot satisfy actor historical prerequisites before introduction", () => {
	const pack = socialPack();
	required(pack.social.capabilities[0]).conditions = [
		{
			predicateId: "trust",
			first: { kind: "actor" },
			second: { kind: "target" },
			operator: "=",
			value: 0,
			window: { mostRecent: 1, leastRecent: 1 },
		},
	];
	const compiled = compileSocialPack(pack),
		world = initialSnapshot(pack.world),
		life = initialLifeState(world, pack.life);
	world.revision = 1;
	world.simulationTime = 1;
	life.worldRevision = 1;
	life.revision = 1;
	life.checkpoint = checkpointFixture();
	required(
		life.checkpoint.data.predicateIntroductions.find((i) => i.id === "trust"),
	).socialStep = 1;
	expect(
		projectSocialActorView(compiled, world, life, "lina", "mira").capabilities,
	).toEqual([]);
});
