import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createContext, runInContext } from "node:vm";
import { createPinnedEnsemble } from "../src/life/social/pinned.ts";
import type {
	EngineAction,
	EngineApi,
} from "../src/life/social/pinned-types.ts";
import manifest from "../vendor/ensemble/manifest.json";
import fixtureManifest from "./social-fixtures/upstream/manifest.json";

test("independent compatibility subset matches pinned original Underscore fixture effects", () => {
	for (const file of fixtureManifest)
		expect(
			createHash("sha256")
				.update(
					readFileSync(
						new URL(`./social-fixtures/upstream/${file.file}`, import.meta.url),
					),
				)
				.digest("hex"),
		).toBe(file.sha256);
	const fixture = Object.fromEntries(
		[
			"schema",
			"cast",
			"actions",
			"history",
			"triggerRules",
			"volitionRules",
		].map((name) => [
			name,
			JSON.parse(
				readFileSync(
					new URL(
						`./social-fixtures/upstream/${name}.json.txt`,
						import.meta.url,
					),
					"utf8",
				),
			),
		]),
	);
	const body = `
 ensemble.init();ensemble.loadSocialStructure(fixture.schema);const cast=ensemble.addCharacters(fixture.cast);
 ensemble.addRules(fixture.triggerRules);ensemble.addRules(fixture.volitionRules);ensemble.addActions(fixture.actions);ensemble.addHistory(fixture.history);
 const predicate={category:"feeling",type:"closeness",first:"hero",second:"love"};
 ensemble.set({...predicate,value:10,origin:"parity"});
 const vs=ensemble.calculateVolition(cast);
 const candidates=ensemble.getActions("hero","love",vs,cast,3,3);
 const selected=candidates.find(a=>a.name==="writeLoveNoteReject");if(!selected)throw Error("Missing original fixture terminal");
 ensemble.doAction(selected);const after=ensemble.get(predicate)[0].value;
 const trigger=ensemble.runTriggerRules(cast);
 return {candidateNames:candidates.map(a=>a.name),selected:selected.name,effects:selected.effects,after,trigger};`;
	const original = createContext({ packet: JSON.stringify(fixture) });
	const modules = manifest.modules
		.map(
			(m) =>
				`var ${m.name}=(function(){${readFileSync(new URL(`../vendor/ensemble/${m.file}`, import.meta.url), "utf8")}\n})();`,
		)
		.join("\n");
	const underscore = readFileSync(
		new URL(
			"./social-fixtures/upstream/underscore-1.6.0.js.txt",
			import.meta.url,
		),
		"utf8",
	);
	runInContext(
		`var console={log(){},warn(){},error(){}};Math.random=()=>0.25;${underscore}\n${modules}`,
		original,
		{ timeout: 3000 },
	);
	const expected = JSON.parse(
		runInContext(
			`JSON.stringify((function(){const fixture=JSON.parse(packet);${body}})())`,
			original,
			{ timeout: 3000 },
		),
	);
	const engine = createPinnedEnsemble({ random: () => 0.25 });
	// Fixed fixture program against the pinned public API; no authored source is evaluated.
	const run = new Function("ensemble", "fixture", body) as (
		api: EngineApi,
		fixture: unknown,
	) => { after: number; selected: string; effects: EngineAction["effects"] };
	const actual = JSON.parse(JSON.stringify(run(engine.api, fixture)));
	expect(actual).toEqual(expected);
	expect(actual.after).toBe(20);
	expect(actual.selected).toBe("writeLoveNoteReject");
});
