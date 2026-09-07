import { expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";

test("native Node broker survives rejected upgrade TCP resets", async () => {
	const root = new URL("../", import.meta.url);
	const outdir = fileURLToPath(new URL(".qa/node/", root));
	await mkdir(outdir, { recursive: true });
	const build = await Bun.build({
		entrypoints: [fileURLToPath(new URL("scripts/qa-node.ts", root))],
		target: "node",
		format: "esm",
		outdir,
		naming: "broker.mjs",
	});
	expect(build.success).toBe(true);
	const process = Bun.spawn(["node", `${outdir}/broker.mjs`], {
		stdout: "pipe",
		stderr: "pipe",
	});
	const [status, output, errors] = await Promise.all([
		process.exited,
		new Response(process.stdout).text(),
		new Response(process.stderr).text(),
	]);
	expect(errors).toBe("");
	expect(status).toBe(0);
	expect(output).toContain("PASS");
});
