import { strict as assert } from "node:assert";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { loadWebAssets } from "../../packages/lina-web/src/assets.ts";

// Use the runtime's actual build path, including CSS, theme boot and PWA assets.
const assets = await loadWebAssets();
for (const key of ["html", "script", "css", "themeScript", "icon"] as const) {
	const value = assets[key];
	assert(typeof value === "string" && value.length > 0, `Missing built ${key}`);
}
const temporary = mkdtempSync(join(tmpdir(), "lina-ci-build-"));
try {
	const home = join(temporary, "lina-home");
	const command = resolve(
		import.meta.dir,
		"../../packages/lina-runtime/scripts/lina.ts",
	);
	const child = Bun.spawn([process.execPath, command, "paths"], {
		cwd: temporary,
		// A new environment prevents inherited provider credentials/state paths.
		env: { PATH: process.env["PATH"] ?? "", LINA_HOME: home },
		stdout: "pipe",
		stderr: "pipe",
	});
	const [output, errors, code] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	assert.equal(code, 0, errors);
	const paths: unknown = JSON.parse(output);
	assert(
		paths !== null &&
			typeof paths === "object" &&
			"home" in paths &&
			paths.home === home,
		"CLI resolved the wrong home",
	);
	assert(!existsSync(home), "Read-only paths command created state");
	console.log(
		`Runtime assets built (${assets.script.length} JS / ${assets.css.length} CSS characters); CLI paths smoke passed without state writes.`,
	);
} finally {
	rmSync(temporary, { recursive: true, force: true });
}
