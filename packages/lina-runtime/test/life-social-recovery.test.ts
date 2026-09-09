// biome-ignore-all lint/complexity/useLiteralKeys: TypeScript requires bracket access for index signatures.
import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { lifeDigest } from "../../lina-core/src/world/life-json.ts";
import { decodeSocialValue } from "../../lina-core/src/world/social-codec.ts";
import type { EnsembleCheckpoint } from "../../lina-core/src/world/social-types.ts";
import { createEnsembleSocialEngine } from "../src/life/social/ensemble.ts";
import { runSocialProcess } from "../src/life/social/process.ts";
import {
	continueInput,
	engineInput,
	richPack,
} from "./social-fixtures/engine-input.ts";

const signal = () => new AbortController().signal;
const entrypoint = fileURLToPath(
	new URL("./social-fixtures/recovery-worker.ts", import.meta.url),
);

test("real process restart restores full state and identical future choices", async () => {
	// The control retains its live engine across both decisions; restored work uses a new PID.
	const pack = richPack();
	pack.roles.push({
		agentId: "nora",
		roleId: "resident",
		description: "Inactive fixture observer",
		status: "active",
	});
	pack.world.agents.push("nora");
	pack.world.agents.sort();
	pack.life.participants.push("nora");
	pack.life.participants.sort();
	const input = engineInput(pack);
	if (input.identity.version !== 1)
		throw Error("Expected legacy identity fixture");
	input.identity.profiles.push({
		agentId: "nora",
		profileRevision: 1,
		evolution: "adaptive",
		lockedTraitIds: [],
		lockedHabitIds: [],
		lockedAttitudeIds: [],
	});

	for (const variant of ["offstage", "eliminated"] as const) {
		const packet = { input, mode: "checkpoint", inactive: variant };
		const savedResult = await runSocialProcess({
			entrypoint,
			input: JSON.stringify(packet),
			signal: signal(),
		});
		const saved = JSON.parse(savedResult.output) as {
			pid: number;
			saved: EnsembleCheckpoint;
		};
		expect(existsSync(`/proc/${saved.pid}`)).toBe(false);
		const control = await runSocialProcess({
			entrypoint,
			input: JSON.stringify({ ...packet, mode: "control" }),
			signal: signal(),
		});
		const restoredInput = structuredClone(input);
		restoredInput.checkpoint = saved.saved;
		restoredInput.bootstrap = null;
		restoredInput.world.revision = 1;
		restoredInput.world.simulationTime = 1;
		restoredInput.life = {
			...restoredInput.life,
			version: 2,
			revision: 1,
			worldRevision: 1,
			knowledgeGrants: [],
			checkpoint: saved.saved,
		};
		const restored = await runSocialProcess({
			entrypoint,
			input: JSON.stringify({
				...packet,
				mode: "restore",
				input: restoredInput,
				checkpoint: saved.saved,
			}),
			signal: signal(),
		});
		const a = JSON.parse(control.output),
			b = JSON.parse(restored.output);
		expect(new Set([saved.pid, a.pid, b.pid]).size).toBe(3);
		for (const pid of [a.pid, b.pid])
			expect(existsSync(`/proc/${pid}`)).toBe(false);
		expect(b.before).toEqual(a.before);
		expect(b.result).toEqual(a.result);
		expect(JSON.stringify(b.result)).toBe(JSON.stringify(a.result));
		expect(b.definitionsUnchanged).toBe(true);
		expect(b.restoredCache).toEqual(saved.saved.data.state.volitionCache);
	}
});

test("two worlds resolve simultaneously without shared history or RNG", async () => {
	const a = engineInput(),
		b = engineInput();
	b.rulePack.worldId = "world-b";
	b.rulePack.life.worldId = "world-b";
	b.world.definition.id = "world-b";
	b.life.worldId = "world-b";
	const { digest: _packDigest, ...packBody } = b.rulePack;
	b.rulePack.digest = lifeDigest(packBody);
	if (!b.bootstrap) throw Error("Missing bootstrap");
	b.bootstrap.worldId = "world-b";
	b.bootstrap.seed = 9876;
	const { digest: _bootstrapDigest, ...bootstrapBody } = b.bootstrap;
	b.bootstrap.digest = lifeDigest(bootstrapBody);
	const engine = createEnsembleSocialEngine();
	const [firstA, firstB] = await Promise.all([
		engine.resolve(a, signal()),
		engine.resolve(b, signal()),
	]);
	expect(firstA.checkpoint).not.toEqual(firstB.checkpoint);
	const [nextA, nextB] = await Promise.all([
		engine.resolve(continueInput(a, firstA), signal()),
		engine.resolve(continueInput(b, firstB), signal()),
	]);
	expect(nextA.effects).toEqual(nextB.effects);
	if (nextA.kind !== "advanced" || nextB.kind !== "advanced")
		throw Error("Missing checkpoint");
	expect(nextA.checkpoint.data.worldId).toBe("test-world");
	expect(nextB.checkpoint.data.worldId).toBe("world-b");
	expect(nextA.checkpoint.data.rng.seed).toBe(123456);
	expect(nextB.checkpoint.data.rng.seed).toBe(9876);
	expect(decodeSocialValue(nextA.checkpoint.data.state.history)).toEqual(
		decodeSocialValue(nextB.checkpoint.data.state.history),
	);
});

test("checkpoint retains named array metadata, own undefined fields and variable introductions", async () => {
	const input = engineInput(richPack());
	const engine = createEnsembleSocialEngine();
	const first = await engine.resolve(input, signal());
	if (first.kind !== "advanced") throw Error("Missing checkpoint");
	const raw = decodeSocialValue(first.checkpoint.data.state.volitionCache);
	const influence = Reflect.get(
		Reflect.get(
			Reflect.get(Reflect.get(raw as object, "main"), "lina"),
			"mira",
		)[0],
		"englishInfluences",
	)[0];
	expect(Array.isArray(influence)).toBe(true);
	expect(influence.length).toBe(0);
	expect(influence.ruleName).toBe("private-reluctance");
	expect(influence.weight).toBe(-30);
	const history = decodeSocialValue(first.checkpoint.data.state.history);
	if (!Array.isArray(history)) throw Error("Missing history");
	const numeric = history[0].find(
		(row: { category: string }) => row.category === "p_636c6f73656e657373",
	);
	expect(Object.hasOwn(numeric, "duration")).toBe(true);
	expect(numeric.duration).toBeUndefined();
	const next = continueInput(input, first);
	if (next.checkpoint.engineId !== "ensemble")
		throw Error("Missing checkpoint");
	next.checkpoint.data.variables["count"] = 7;
	next.checkpoint.data.state.noRepeat["choice"] = 3;
	next.checkpoint.data.state.iterators["fixture"] = 12;
	next.checkpoint.dataDigest = lifeDigest(next.checkpoint.data);
	const result = await engine.resolve(next, signal());
	if (result.kind !== "advanced") throw Error("Missing restored checkpoint");
	expect(result.checkpoint.data.variables["count"]).toBe(7);
	expect(result.checkpoint.data.state.noRepeat["choice"]).toBe(3);
	expect(result.checkpoint.data.state.iterators["fixture"]).toBe(12);
	expect(result.checkpoint.data.variableIntroductions).toEqual(
		first.checkpoint.data.variableIntroductions,
	);
});

test("recomputed checksums cannot admit malformed history schema or exhausted counters", async () => {
	const input = engineInput();
	const engine = createEnsembleSocialEngine();
	const first = await engine.resolve(input, signal());
	for (const mutation of ["schema", "counter"] as const) {
		const next = continueInput(input, first);
		if (next.checkpoint.engineId !== "ensemble")
			throw Error("Missing checkpoint");
		if (mutation === "schema") {
			const { encodeSocialValue } = await import(
				"../../lina-core/src/world/social-codec.ts"
			);
			const history = decodeSocialValue(next.checkpoint.data.state.history);
			if (!Array.isArray(history)) throw Error("Missing history");
			history[0][0].category = "forged";
			next.checkpoint.data.state.history = encodeSocialValue(history);
		} else next.checkpoint.data.state.iterators["socialRecords"] = 0;
		next.checkpoint.dataDigest = lifeDigest(next.checkpoint.data);
		await expect(engine.resolve(next, signal())).rejects.toThrow();
	}
});
