import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { decodePublicCase } from "./public-case.ts";
import { generateCase } from "./scenarios.ts";
import { BEHAVIOR_IDS, decodeTruth } from "./truth.ts";
export type BatchManifest = {
	version: 1;
	seed: string;
	purpose: "development" | "qualification";
	episodes: {
		episodeId: string;
		row: string;
		variant: number;
		subcase: string;
		publicPath: string;
		truthPath: string;
		publicHash: string;
		truthHash: string;
	}[];
};
export function exportBatch(
	seed: string,
	output: string,
	purpose: BatchManifest["purpose"] = "development",
): BatchManifest {
	const root = resolve(output);
	mkdirSync(join(root, "public"), { recursive: true });
	mkdirSync(join(root, "private"), { recursive: true });
	const manifest: BatchManifest = { version: 1, seed, purpose, episodes: [] };
	for (const row of BEHAVIOR_IDS)
		for (let variant = 0; variant < 4; variant++)
			for (const subcase of row === "B15"
				? (["visible", "omitted"] as const)
				: (["main"] as const)) {
				const generated = generateCase(seed, row, variant, subcase);
				const input = JSON.stringify(decodePublicCase(generated.publicCase));
				const truth = JSON.stringify(decodeTruth(generated.privateTruth));
				const id = generated.publicCase.episodeId;
				const publicPath = join(root, "public", `${id}.json`),
					truthPath = join(root, "private", `${id}.json`);
				writeFileSync(publicPath, `${input}\n`, { flag: "wx" });
				writeFileSync(truthPath, `${truth}\n`, { flag: "wx" });
				manifest.episodes.push({
					episodeId: id,
					row,
					variant,
					subcase,
					publicPath,
					truthPath,
					publicHash: createHash("sha256").update(input).digest("hex"),
					truthHash: createHash("sha256").update(truth).digest("hex"),
				});
			}
	writeFileSync(
		join(root, "manifest.json"),
		`${JSON.stringify(manifest, null, 2)}\n`,
		{ flag: "wx" },
	);
	return manifest;
}
