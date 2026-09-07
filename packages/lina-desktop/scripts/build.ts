import { mkdir, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { loadWebAssets } from "../../lina-web/src/assets.ts";
import { writeBundle } from "./bundle-assets.ts";

const root = new URL("../", import.meta.url);
const out = fileURLToPath(new URL("dist/", root));
const assets = await loadWebAssets();
// Only generated package output is replaced; userData and sessions are elsewhere.
await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });
await writeBundle(fileURLToPath(new URL("dist/assets/", root)), assets);
for (const entry of ["main", "preload"]) {
	const result = await Bun.build({
		entrypoints: [fileURLToPath(new URL(`src/${entry}.ts`, root))],
		outdir: out,
		naming: `${entry}.cjs`,
		target: "node",
		format: "cjs",
		external: ["electron"],
	});
	if (!result.success)
		throw new AggregateError(result.logs, `Desktop ${entry} build failed`);
}
console.log(
	`Desktop main, preload and bundled shared renderer built in ${out}`,
);
