import { createHash } from "node:crypto";
import { serviceWorkerSource } from "./service-worker.ts";
export type ShellFile = {
	body: string | Uint8Array<ArrayBuffer>;
	mime: string;
};
export type PwaAssets = {
	version: string;
	files: Map<string, ShellFile>;
	worker: string;
	manifest: string;
};
type Input = {
	html: string;
	script: string;
	css: string;
	themeScript: string;
	icon: string;
};
export function createPwaAssets(
	input: Input,
	small: Uint8Array<ArrayBuffer>,
	large: Uint8Array<ArrayBuffer>,
): { html: string; pwa: PwaAssets } {
	const version = createHash("sha256")
		.update(JSON.stringify(input))
		.update(small)
		.update(large)
		.update(serviceWorkerSource.toString())
		.digest("hex")
		.slice(0, 20);
	const prefix = `/assets/${version}`;
	const manifest = JSON.stringify({
		id: "/",
		name: "Lina · 나의 비서",
		short_name: "Lina",
		lang: "ko",
		start_url: "/",
		scope: "/",
		display: "standalone",
		background_color: "#222326",
		theme_color: "#222326",
		icons: [
			{
				src: `${prefix}/icon-192.png`,
				sizes: "192x192",
				type: "image/png",
				purpose: "any maskable",
			},
			{
				src: `${prefix}/icon-512.png`,
				sizes: "512x512",
				type: "image/png",
				purpose: "any maskable",
			},
		],
	});
	const html = input.html
		.replaceAll('href="/favicon.svg"', `href="${prefix}/favicon.svg"`)
		.replaceAll('src="/theme.js"', `src="${prefix}/theme.js"`)
		.replaceAll('src="/app.js"', `src="${prefix}/app.js"`)
		.replaceAll('href="/styles.css"', `href="${prefix}/styles.css"`)
		.replace(
			"</head>",
			`<link rel="manifest" href="${prefix}/manifest.webmanifest" /><link rel="apple-touch-icon" href="${prefix}/icon-192.png" /><meta name="mobile-web-app-capable" content="yes" /></head>`,
		);
	const files = new Map<string, ShellFile>([
		[`${prefix}/shell.html`, { body: html, mime: "text/html; charset=utf-8" }],
		[
			`${prefix}/app.js`,
			{ body: input.script, mime: "text/javascript; charset=utf-8" },
		],
		[
			`${prefix}/theme.js`,
			{ body: input.themeScript, mime: "text/javascript; charset=utf-8" },
		],
		[
			`${prefix}/styles.css`,
			{ body: input.css, mime: "text/css; charset=utf-8" },
		],
		[`${prefix}/favicon.svg`, { body: input.icon, mime: "image/svg+xml" }],
		[
			`${prefix}/manifest.webmanifest`,
			{ body: manifest, mime: "application/manifest+json" },
		],
		[`${prefix}/icon-192.png`, { body: small, mime: "image/png" }],
		[`${prefix}/icon-512.png`, { body: large, mime: "image/png" }],
	]);
	return {
		html,
		pwa: {
			version,
			files,
			manifest,
			worker: serviceWorkerSource(
				version,
				[...files.keys()],
				`${prefix}/shell.html`,
			),
		},
	};
}
