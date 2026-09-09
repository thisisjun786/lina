import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { createContext, runInContext } from "node:vm";

const PINNED_SHA = "8b74bdec4ba2ef4e14795b7591df3b5d73f283e3";
const SEED = 123456;
const VM_TIMEOUT_MS = 3000;
const FIXTURE = "tests/externalApplicationFiles/dataLoversAndRivals";
// Standalone module order and wrappers from the pinned build-library.js.
const MODULES = [
	["underscore", "ensemble/jslib/underscore-min.js", "none"],
	["util", "ensemble/jslib/util.js", "IIFE"],
	["socialRecord", "ensemble/socialRecord.js", "IIFE"],
	["ruleLibrary", "ensemble/RuleLibrary.js", "IIFE"],
	["actionLibrary", "ensemble/ActionLibrary.js", "IIFE"],
	["volition", "ensemble/Volition.js", "IIFE"],
	["validate", "ensemble/Validate.js", "IIFE"],
	["ensemble", "ensemble/ensemble.js", "IIFE"],
] as const;
const FIXTURE_FILES = [
	"schema",
	"cast",
	"triggerRules",
	"volitionRules",
	"actions",
	"history",
] as const;

function git(root: string, ...args: string[]): Buffer {
	return execFileSync(
		"git",
		["--no-optional-locks", "-c", "core.fsmonitor=false", "-C", root, ...args],
		{
			stdio: ["ignore", "pipe", "pipe"],
			timeout: 10000,
			maxBuffer: 16 * 1024 * 1024,
		},
	);
}

function verifiedSource(path: string) {
	const root = realpathSync(resolve(path));
	assert.equal(
		realpathSync(git(root, "rev-parse", "--show-toplevel").toString().trim()),
		root,
		"Source path must be the checkout root",
	);
	const sha = git(root, "rev-parse", "--verify", "HEAD").toString().trim();
	assert.equal(sha, PINNED_SHA, "Unexpected upstream revision");
	assert.equal(
		git(root, "status", "--porcelain=v1", "--untracked-files=all").toString(),
		"",
		"Upstream checkout is dirty",
	);
	const inputs = [
		"build-library.js",
		...MODULES.map(([, file]) => file),
		...FIXTURE_FILES.map((name) => `${FIXTURE}/${name}.json`),
	];
	const digest = createHash("sha256");
	const files = new Map<string, string>();
	for (const file of inputs) {
		const sourcePath = join(root, file);
		assert.ok(
			lstatSync(sourcePath).isFile(),
			`Expected regular source file: ${file}`,
		);
		assert.equal(
			realpathSync(sourcePath),
			sourcePath,
			`Source symlink is not allowed: ${file}`,
		);
		const bytes = readFileSync(sourcePath);
		assert.ok(
			bytes.equals(git(root, "show", `${PINNED_SHA}:${file}`)),
			`Source bytes differ from pinned commit: ${file}`,
		);
		digest.update(file).update("\0").update(bytes).update("\0");
		files.set(file, bytes.toString("utf8"));
	}
	const read = (file: string): string => {
		const text = files.get(file);
		assert.ok(text !== undefined, `Unverified source requested: ${file}`);
		return text;
	};
	const manifest = [
		...read("build-library.js").matchAll(
			/\{name:\s*"([^"]+)",\s*path:\s*"([^"]+)"(?:,\s*wrapper:\s*"([^"]+)")?\}/g,
		),
	].map((match) => [match[1], match[2], match[3] ?? "IIFE"]);
	assert.deepEqual(manifest, MODULES, "Standalone module order changed");
	const bundle =
		"globalThis.ensemble = (function(){\n" +
		MODULES.map(([name, file, wrapper]) =>
			wrapper === "none"
				? read(file)
				: `const ${name} = (function(){\n${read(file)}\n})();`,
		).join("\n") +
		"\nreturn ensemble;\n})();";
	const fixture = Object.fromEntries(
		FIXTURE_FILES.map((name) => [
			name,
			JSON.parse(read(`${FIXTURE}/${name}.json`)) as unknown,
		]),
	);
	return {
		sha,
		bundle,
		fixture,
		verifiedFiles: inputs.length,
		inputDigest: digest.digest("hex"),
	};
}

function world(source: ReturnType<typeof verifiedSource>) {
	// Separate realms isolate engine globals; node:vm is not a security sandbox.
	const context = createContext({});
	runInContext(
		`
		globalThis.console = { log() {}, warn() {}, error() {} };
		globalThis.probeRng = { seed: ${SEED}, state: ${SEED}, draws: 0 };
		Math.random = () => {
			probeRng.state = (Math.imul(probeRng.state, 1664525) + 1013904223) >>> 0;
			probeRng.draws++;
			return probeRng.state / 4294967296;
		};
	`,
		context,
		{ timeout: VM_TIMEOUT_MS },
	);
	runInContext(source.bundle, context, {
		timeout: VM_TIMEOUT_MS,
		filename: "verified-ensemble-standalone.js",
	});
	function run<T>(body: string, input: unknown = null): T {
		// Every fixture/history object is JSON-parsed inside its own realm: util.clone
		// relies on instanceof, so passing host or another world's objects is invalid.
		const script = `JSON.stringify((() => { const input = JSON.parse(${JSON.stringify(JSON.stringify(input))}); ${body} })())`;
		const output: unknown = runInContext(script, context, {
			timeout: VM_TIMEOUT_MS,
		});
		assert.ok(typeof output === "string", "Expected JSON result from probe");
		// T describes only our fixed harness return expressions, not upstream input.
		return JSON.parse(output) as T;
	}
	run(
		`
		ensemble.init();
		ensemble.loadSocialStructure(input.schema);
		globalThis.cast = ensemble.addCharacters(input.cast);
		ensemble.addRules(input.triggerRules);
		ensemble.addRules(input.volitionRules);
		ensemble.addActions(input.actions);
		ensemble.addHistory(input.history);
		globalThis.predicate = { category: "feeling", type: "closeness", first: "hero", second: "love" };
		return null;
	`,
		source.fixture,
	);
	return { run };
}

type Trial = {
	cast: string[];
	candidates: string[];
	action: string;
	before: number;
	after: number;
	reverseBefore: number;
	reverseAfter: number;
	random: { seed: number; draws: number; state: number };
	history: unknown[];
};

function trial(engine: ReturnType<typeof world>): Trial {
	const result = engine.run<Trial>(`
		const reverse = { ...predicate, first: "love", second: "hero" };
		ensemble.set({ ...predicate, value: 10 });
		const before = ensemble.get(predicate)[0].value;
		const reverseBefore = ensemble.get(reverse)[0].value;
		const volitions = ensemble.calculateVolition(cast);
		const candidates = ensemble.getActions("hero", "love", volitions, cast, 3, 3);
		const selected = candidates.find(action => action.effects?.some(effect =>
			effect.category === "feeling" && effect.type === "closeness" &&
			effect.operator === "+" && effect.first === "hero" && effect.second === "love"));
		if (!selected) throw Error("No bound closeness-increasing action candidate");
		for (const effect of selected.effects) ensemble.set(effect);
		return {
			cast, candidates: candidates.map(action => action.name), action: selected.name,
			before, after: ensemble.get(predicate)[0].value,
			reverseBefore, reverseAfter: ensemble.get(reverse)[0].value,
			random: { ...probeRng }, history: ensemble.getSocialRecordCopy()
		};
	`);
	assert.ok(result.candidates.length > 0, "No getActions candidates");
	assert.equal(result.action, "writeLoveNoteReject");
	assert.equal(result.before, 10);
	assert.equal(result.after, 20);
	assert.equal(
		result.reverseAfter,
		result.reverseBefore,
		"Directed effect changed the reverse relationship",
	);
	assert.deepEqual(result.random, { seed: SEED, draws: 2, state: 870155634 });
	return result;
}

function main() {
	const args = process.argv.slice(2);
	const path = args[1];
	assert.ok(
		args.length === 2 && args[0] === "--source" && path,
		"Usage: bun scripts/qa/life-social-engine-probe.ts --source <checkout-path>",
	);
	const source = verifiedSource(path);
	const active = world(source);
	const first = trial(active);
	const replay = trial(world(source));
	assert.deepEqual(
		{ action: replay.action, random: replay.random },
		{ action: first.action, random: first.random },
		"Same seed/input was not reproducible",
	);
	const restored = world(source).run<number>(
		`
		ensemble.clearHistory();
		ensemble.addHistory(input);
		return ensemble.get(predicate)[0].value;
	`,
		{
			source_file: "lina-qa-json-history",
			history: first.history.map((data, pos) => ({ pos, data })),
		},
	);
	assert.equal(restored, 20);
	const fresh = world(source).run<number>(
		"return ensemble.get(predicate)[0].value;",
	);
	assert.equal(fresh, 0);
	assert.equal(
		active.run<number>("return ensemble.get(predicate)[0].value;"),
		20,
	);
	console.log(
		JSON.stringify({
			ok: true,
			upstream: "ensemble-engine/ensemble",
			sha: source.sha,
			verifiedFiles: source.verifiedFiles,
			inputDigest: source.inputDigest,
			fixture: FIXTURE,
			cast: first.cast,
			candidates: first.candidates,
			action: first.action,
			before: first.before,
			after: first.after,
			reverseUnchanged: true,
			jsonHistoryRestored: restored,
			otherFreshWorld: fresh,
			random: first.random,
			repeat: { action: replay.action, random: replay.random, matches: true },
			providerCalls: 0,
			productionAdoption: false,
			nextActionCheckpointRestore: false,
			vmSecuritySandbox: false,
		}),
	);
}

try {
	main();
} catch (error) {
	console.log(
		JSON.stringify({
			ok: false,
			expectedSha: PINNED_SHA,
			providerCalls: 0,
			error: error instanceof Error ? error.message : String(error),
		}),
	);
	process.exitCode = 1;
}
