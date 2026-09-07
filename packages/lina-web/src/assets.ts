import { fileURLToPath } from "node:url";
import { createPwaAssets } from "./pwa-assets.ts";
import type { WebAssets } from "./server.ts";

async function buildClientEntry(entry: URL): Promise<string> {
	// Keep browser resolution separate from the server's runtime module cache.
	const build = Bun.spawn(
		[
			process.execPath,
			"build",
			fileURLToPath(entry),
			"--target=browser",
			"--minify",
		],
		{
			cwd: fileURLToPath(new URL(".", entry)),
			stdin: "ignore",
			stdout: "pipe",
			stderr: "pipe",
		},
	);
	const [output, errors, exitCode] = await Promise.all([
		new Response(build.stdout).text(),
		new Response(build.stderr).text(),
		build.exited,
	]);
	if (exitCode !== 0 || output.length === 0)
		throw new Error(`Web build failed (${exitCode}): ${errors}`);
	return output;
}

export async function loadWebAssets(): Promise<WebAssets> {
	const client = new URL("../client/", import.meta.url);
	const [script, css, themeScript] = await Promise.all(
		["app.ts", "styles.css", "theme-boot.ts"].map((entry) =>
			buildClientEntry(new URL(entry, client)),
		),
	);
	if (script === undefined || css === undefined || themeScript === undefined)
		throw new Error("Missing web assets");
	const base = {
		icon: await Bun.file(new URL("favicon.svg", client)).text(),
		html: await Bun.file(new URL("index.html", client)).text(),
		script,
		css,
		themeScript,
	};
	const small = new Uint8Array(
		await Bun.file(new URL("icon-192.png", client)).arrayBuffer(),
	);
	const large = new Uint8Array(
		await Bun.file(new URL("icon-512.png", client)).arrayBuffer(),
	);
	return { ...base, ...createPwaAssets(base, small, large) };
}
