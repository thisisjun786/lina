import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import manifest from "../../../vendor/ensemble/manifest.json";
import { ensembleCompatibility } from "../../../vendor/ensemble/underscore.ts";
import type { EngineHooks, PinnedEnsemble } from "./pinned-types.ts";

function sha256(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}
function source(): string {
	const modules = manifest.modules.map((module) => {
		let text = readFileSync(
			new URL(`../../../vendor/ensemble/${module.file}`, import.meta.url),
			"utf8",
		);
		if (sha256(text) !== module.sha256)
			throw Error("Pinned Ensemble source mismatch");
		for (const patch of module.patches) {
			if (text.split(patch.find).length !== 2)
				throw Error(`Invalid Ensemble patch ${patch.id}`);
			text = text.replace(patch.find, () => patch.replace);
		}
		if (sha256(text) !== module.patchedSha256)
			throw Error("Patched Ensemble source mismatch");
		return `var ${module.name}=(function(){${text}\n})();`;
	});
	return (
		`var key, currentUniqueBindings, terminalsAtThisLevel, matchedResults, matchedResultsStrings;\n${modules.join("\n")}\n` +
		`
 return {
  api:ensemble,
  evaluateConditions:ruleLibrary.evaluateConditions,
  resolveRoot:actionLibrary.resolveRoot,
  readState:function(){
   var s=__lina.hooks.socialRecord.read(),u=__lina.hooks.util.read(),v=__lina.hooks.volition.read();
   return {history:s.socialRecord,step:s.currentTimeStep,offstage:s.offstageCharacters,eliminated:s.eliminatedCharacters,
    iterators:u._iterators,noRepeat:u._noRepeatTracker,volitionCache:v.volitionCache,cachePositions:v.cachePositions};
  },
  writeState:function(s){
   __lina.hooks.socialRecord.write({socialRecord:s.history,currentTimeStep:s.step,offstageCharacters:s.offstage,eliminatedCharacters:s.eliminated});
   __lina.hooks.util.write({_iterators:s.iterators,_noRepeatTracker:s.noRepeat});
   __lina.hooks.volition.write({volitionCache:s.volitionCache,cachePositions:s.cachePositions});
  },
  definitions:function(){return Object.fromEntries(Object.entries(__lina.hooks).map(function(entry){return [entry[0],entry[1].definition()];}));}
 };`
	);
}

/** Only hash-checked local code is compiled; authored data is never source text. */
export function createPinnedEnsemble(hooks: EngineHooks): PinnedEnsemble {
	const runtime = {
		hooks: {},
		explicitRoot: false,
		fixedBinding: hooks.fixedBinding ?? (() => undefined),
		tick: hooks.tick ?? (() => {}),
		bindingAllowed: hooks.bindingAllowed ?? (() => true),
		window:
			hooks.window ??
			((_predicate: unknown, recent: number, old: number) => [recent, old]),
		beforeSet: hooks.beforeSet ?? (() => {}),
		matched: hooks.matched ?? (() => {}),
	};
	const engineMath = Object.create(Math) as Math;
	engineMath.random = hooks.random;
	// The sole assertion describes the fixed pinned source ABI, covered by real engine tests.
	const assemble = new Function("_", "Math", "__lina", "console", source()) as (
		...args: unknown[]
	) => PinnedEnsemble;
	return assemble(ensembleCompatibility(hooks.random), engineMath, runtime, {
		log() {},
		warn() {},
		error() {},
	});
}
