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
			"--define",
			'process.env.NODE_ENV="production"',
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
	const client = new URL("../../lina-ui/client/", import.meta.url);
	const [builtScript, css, themeScript] = await Promise.all(
		["app.ts", "styles.css", "theme-boot.ts"].map((entry) =>
			buildClientEntry(new URL(entry, client)),
		),
	);
	if (
		builtScript === undefined ||
		css === undefined ||
		themeScript === undefined
	)
		throw new Error("Missing web assets");
	const licenses = await Bun.file(
		new URL("../THIRD_PARTY_LICENSES.txt", client),
	).text();
	// The same output is served on web and bundled into Electron's ASAR.
	const script = `/*!\n${licenses.replaceAll("*/", "* /")}\n*/\n${builtScript}`;
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
