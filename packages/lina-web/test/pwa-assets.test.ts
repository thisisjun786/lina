import { expect, test } from "bun:test";
import { loadWebAssets } from "../src/assets.ts";
import { startWebServer } from "../src/server.ts";

test("a complete versioned shell serves manifest, icons and a scoped worker", async () => {
	const assets = await loadWebAssets();
	expect(assets.script).not.toContain("Download the React DevTools");
	expect(assets.script).toContain("Copyright (c) 2023 shadcn");
	expect(assets.pwa).toBeDefined();
	if (!assets.pwa) throw new Error("PWA missing");
	const { version, files } = assets.pwa;
	expect(version).toMatch(/^[a-f0-9]{20}$/);
	const server = startWebServer({
		port: 0,
		upstream: "ws://127.0.0.1:1",
		assets,
	});
	try {
		const base = `http://127.0.0.1:${server.port}`;
		const root = await fetch(base);
		const html = await root.text();
		expect(html).toContain(`/assets/${version}/app.js`);
		expect(html).toContain(`/assets/${version}/theme.js`);
		for (const directive of ["manifest-src 'self'", "worker-src 'self'"])
			expect(root.headers.get("Content-Security-Policy")).toContain(directive);
		for (const [path, file] of files) {
			const response = await fetch(`${base}${path}`);
			expect(response.status).toBe(200);
			expect(response.headers.get("Content-Type")).toBe(file.mime);
			expect(await response.arrayBuffer()).toEqual(
				await new Response(file.body).arrayBuffer(),
			);
		}
		const manifest = (await (
			await fetch(`${base}/manifest.webmanifest`)
		).json()) as {
			display: string;
			start_url: string;
			icons: { sizes: string }[];
		};
		expect(manifest.display).toBe("standalone");
		expect(manifest.start_url).toBe("/");
		expect(manifest.icons.map((icon: { sizes: string }) => icon.sizes)).toEqual(
			["192x192", "512x512"],
		);
		const sw = await fetch(`${base}/sw.js`);
		expect(sw.status).toBe(200);
		expect(sw.headers.get("Content-Type")).toContain("javascript");
		expect((await fetch(`${base}/assets/foreign/app.js`)).status).toBe(404);
	} finally {
		await server.stop(true);
	}
});
