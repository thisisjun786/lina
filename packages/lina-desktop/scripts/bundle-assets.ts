import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { WebAssets } from "../../lina-web/src/server.ts";

/** Shared browser output is the sole renderer source; only PWA metadata is omitted. */
export async function writeBundle(
	directory: string,
	assets: WebAssets,
): Promise<void> {
	await mkdir(directory, { recursive: true });
	const html = assets.html.replace(/<link\b[^>]*\brel="manifest"[^>]*>/gi, "");
	const files = new Map([
		["/", { body: html, mime: "text/html; charset=utf-8" }],
		[
			"/app.js",
			{ body: assets.script, mime: "text/javascript; charset=utf-8" },
		],
		["/styles.css", { body: assets.css, mime: "text/css; charset=utf-8" }],
		[
			"/theme.js",
			{
				body: assets.themeScript ?? "",
				mime: "text/javascript; charset=utf-8",
			},
		],
		["/favicon.svg", { body: assets.icon, mime: "image/svg+xml" }],
	]);
	const manifest: Array<{ url: string; file: string; mime: string }> = [];
	const all = new Map<string, { body: string | Uint8Array; mime: string }>(
		files,
	);
	for (const [url, value] of assets.pwa?.files ?? []) {
		if (!url.endsWith(".html") && !url.endsWith(".webmanifest"))
			all.set(url, value);
	}
	for (const [url, value] of all) {
		const body =
			typeof value.body === "string"
				? Buffer.from(value.body)
				: Buffer.from(value.body);
		const file = `${createHash("sha256").update(body).digest("hex")}.bin`;
		await writeFile(join(directory, file), body);
		manifest.push({ url, file, mime: value.mime });
	}
	await writeFile(
		join(directory, "manifest.json"),
		`${JSON.stringify({ format: 1, rendererVersion: assets.pwa?.version, files: manifest }, null, 2)}\n`,
	);
}
