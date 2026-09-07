import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { SocialResolveInput } from "../../lina-core/src/world/social-types.ts";
import { parseSocialResolution } from "../../lina-core/src/world/social-validation.ts";
import { installRelease } from "../src/install-release.ts";
import manifest from "../vendor/ensemble/manifest.json";
import { continueInput, engineInput } from "./social-fixtures/engine-input.ts";

test("installed Ensemble resolves and resumes in fresh processes outside the checkout", async () => {
	const root = mkdtempSync(join(tmpdir(), "lina-release-ensemble-smoke-"));
	try {
		const source = resolve(import.meta.dir, "../../..");
		const release = await installRelease({
			source,
			home: join(root, "home"),
			// The social worker uses only local source and Bun built-ins.
			prepare: async () => {},
		});
		const vendor = "packages/lina-runtime/vendor/ensemble";
		for (const relative of [
			"LICENSE",
			"NOTICE",
			"THIRD_PARTY_NOTICES.md",
			`${vendor}/manifest.json`,
			`${vendor}/underscore.ts`,
			`${vendor}/${manifest.license.file}`,
			...manifest.modules.map((module) => `${vendor}/${module.file}`),
		]) {
			expect(readFileSync(join(release.path, relative))).toEqual(
				readFileSync(join(source, relative)),
			);
		}
		const license = readFileSync(
			join(release.path, vendor, manifest.license.file),
		);
		expect(createHash("sha256").update(license).digest("hex")).toBe(
			manifest.license.sha256,
		);
		expect(manifest.revision).toBe("8b74bdec4ba2ef4e14795b7591df3b5d73f283e3");
		expect(existsSync(join(release.path, "node_modules"))).toBe(false);
		expect(existsSync(join(release.path, "packages/lina-runtime/test"))).toBe(
			false,
		);
		const runner = join(root, "resolve.ts");
		writeFileSync(
			runner,
			`const { createEnsembleSocialEngine } = await import(process.argv[2]);
const input = JSON.parse(await Bun.stdin.text());
const result = await createEnsembleSocialEngine().resolve(input, new AbortController().signal);
process.stdout.write(JSON.stringify(result));
`,
		);
		const entrypoint = pathToFileURL(
			join(release.path, "packages/lina-runtime/src/life/social/ensemble.ts"),
		).href;
		const run = async (input: SocialResolveInput) => {
			const child = Bun.spawn(
				[process.execPath, "--no-install", "--no-env-file", runner, entrypoint],
				{
					cwd: root,
					env: { LANG: "C" },
					stdin: "pipe",
					stdout: "pipe",
					stderr: "pipe",
				},
			);
			child.stdin.write(JSON.stringify(input));
			child.stdin.end();
			const [output, errors, code] = await Promise.all([
				new Response(child.stdout).text(),
				new Response(child.stderr).text(),
				child.exited,
			]);
			expect(code, errors).toBe(0);
			expect(existsSync(`/proc/${child.pid}`)).toBe(false);
			return parseSocialResolution(JSON.parse(output));
		};
		const input = engineInput();
		const first = await run(input);
		expect(first.kind).toBe("advanced");
		expect(first.outcome).toBe("accepted");
		expect(first.effects).toContainEqual({
			kind: "predicate",
			predicateId: "trust",
			firstAgentId: "lina",
			secondAgentId: "mira",
			previous: 0,
			next: 1,
		});
		expect(first.checkpoint.engineId).toBe("ensemble");
		const restoredInput = JSON.parse(
			JSON.stringify(continueInput(input, first)),
		);
		const next = await run(restoredInput);
		expect(next.outcome).toBe("accepted");
		expect(next.effects).toContainEqual({
			kind: "predicate",
			predicateId: "trust",
			firstAgentId: "lina",
			secondAgentId: "mira",
			previous: 1,
			next: 2,
		});
		expect(await run(restoredInput)).toEqual(next);
		console.info(
			`Installed Ensemble artifact ${release.release}: resolve and restart smoke passed.`,
		);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
	expect(existsSync(root)).toBe(false);
});
