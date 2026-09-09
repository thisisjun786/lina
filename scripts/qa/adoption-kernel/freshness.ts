import { createHash, randomBytes } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { candidateDigests } from "./candidate.ts";
import { RunRegistry } from "./run-registry.ts";
import { exportBatch } from "./scenario-export.ts";
export function createFreeze(path: string): void {
	writeFileSync(
		path,
		JSON.stringify({
			version: 1,
			at: new Date().toISOString(),
			...candidateDigests(),
		}),
		{ flag: "wx" },
	);
}
export function readFreeze(path: string) {
	const bytes = readFileSync(path);
	const value = JSON.parse(bytes.toString("utf8"));
	if (
		!value ||
		typeof value !== "object" ||
		Array.isArray(value) ||
		Object.keys(value).sort().join() !==
			["version", "at", "sourceHash", "generatorHash", "rubricHash"]
				.sort()
				.join() ||
		value.version !== 1 ||
		typeof value.at !== "string" ||
		!Number.isFinite(Date.parse(value.at)) ||
		Date.parse(value.at) > Date.now()
	)
		throw Error("invalid freeze");
	for (const [key, hash] of Object.entries(candidateDigests()))
		if (value[key] !== hash) throw Error("frozen candidate changed");
	return {
		...candidateDigests(),
		at: value.at as string,
		hash: createHash("sha256").update(bytes).digest("hex"),
	};
}
export function exportFresh(
	freezePath: string,
	registryPath: string,
	output: string,
) {
	const freeze = readFreeze(freezePath);
	const registry = new RunRegistry(registryPath);
	try {
		const seed = randomBytes(32).toString("hex");
		registry.beginGeneration(seed, freeze.hash);
		const manifest = exportBatch(seed, output, "qualification");
		if (readFreeze(freezePath).hash !== freeze.hash)
			throw Error("freeze changed during generation");
		const manifestPath = resolve(join(output, "manifest.json"));
		registry.finishGeneration(
			seed,
			manifestPath,
			createHash("sha256").update(readFileSync(manifestPath)).digest("hex"),
		);
		return manifest;
	} finally {
		registry.close();
	}
}
