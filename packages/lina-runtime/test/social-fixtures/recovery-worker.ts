import {
	decodeSocialValue,
	encodeSocialValue,
} from "../../../lina-core/src/world/social-codec.ts";
import type {
	EnsembleCheckpoint,
	SocialResolveInput,
} from "../../../lina-core/src/world/social-types.ts";
import { parseSocialResolveInput } from "../../../lina-core/src/world/social-validation.ts";
import {
	checkpointEnsemble,
	engineRandom,
	initializeEnsemble,
} from "../../src/life/social/checkpoint.ts";
import { createPinnedEnsemble } from "../../src/life/social/pinned.ts";
import { engineTables } from "../../src/life/social/tables.ts";

const packet = JSON.parse(await Bun.stdin.text()) as {
	input: SocialResolveInput;
	mode: "control" | "checkpoint" | "restore";
	checkpoint?: EnsembleCheckpoint;
	inactive: "offstage" | "eliminated";
};
const input = parseSocialResolveInput(packet.input);
const random = engineRandom(input),
	tables = engineTables(input.rulePack);
const engine = createPinnedEnsemble({
	random: random.random,
	bindingAllowed: tables.bindingAllowed,
	fixedBinding: tables.fixedBinding,
});
tables.load(engine);
initializeEnsemble(input, engine);
const originalDefinitions = encodeSocialValue(engine.definitions());
function advance(boundary: SocialResolveInput) {
	engine.api.setupNextTimeStep();
	const state = engine.readState();
	const cast = input.rulePack.cast
		.filter(
			(c) =>
				c.active &&
				!state.offstage.includes(c.agentId) &&
				!state.eliminated.includes(c.agentId),
		)
		.map((c) => c.agentId);
	const volition = engine.api.calculateVolition(cast);
	const first = volition.getFirst("lina", "mira");
	const selected = engine.resolveRoot(
		"greet",
		"lina",
		"mira",
		true,
		first?.weight ?? 0,
		cast,
		1000,
	);
	if (!selected.action) throw Error("Missing recovery terminal");
	engine.api.doAction(selected.action);
	const trigger = engine.api.runTriggerRules(cast);
	const checkpoint = checkpointEnsemble(boundary, engine, random.state);
	return { selected, trigger, checkpoint };
}
let saved: EnsembleCheckpoint;
if (packet.mode === "restore") {
	if (!packet.checkpoint) throw Error("Missing checkpoint");
	saved = packet.checkpoint;
} else {
	const first = advance(input);
	// Inactive fourth participant has no required role in the next requested action.
	if (packet.inactive === "offstage") engine.api.setCharacterOffstage("nora");
	else engine.api.setCharacterEliminated("nora");
	saved = checkpointEnsemble(input, engine, random.state);
	if (first.checkpoint.data.state.step !== 1)
		throw Error("Missing first advancement");
}
const next = structuredClone(input);
next.world.revision = saved.data.worldRevision;
next.life.revision = saved.data.lifeRevision;
next.life.worldRevision = saved.data.worldRevision;
next.simulationTime = saved.data.simulationTime + 1;
next.checkpoint = saved;
next.life.checkpoint = saved;
if (packet.mode === "checkpoint")
	process.stdout.write(JSON.stringify({ pid: process.pid, saved }));
else {
	const before = encodeSocialValue(engine.readState());
	const result = advance(next);
	const restoredCache = decodeSocialValue(saved.data.state.volitionCache);
	process.stdout.write(
		JSON.stringify({
			pid: process.pid,
			before,
			result,
			restoredCache: encodeSocialValue(restoredCache),
			definitionsUnchanged:
				JSON.stringify(originalDefinitions) ===
				JSON.stringify(encodeSocialValue(engine.definitions())),
		}),
	);
}
