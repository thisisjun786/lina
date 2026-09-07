import { expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { writeBundle } from "../scripts/bundle-assets.ts";
import { loadBundle } from "../src/bundled-assets.ts";

test("disk bundle survives without Bun/web source and preserves versioned asset URLs", async () => {
	const qa = fileURLToPath(new URL("../.qa/", import.meta.url));
	await mkdir(qa, { recursive: true });
	const dir = await mkdtemp(join(qa, "bundle-"));
	await writeBundle(dir, {
		html: '<html><head><link rel="manifest" href="/assets/rev/manifest.webmanifest" /></head><script src="/assets/rev/app.js"></script></html>',
		script: "console.log('shared renderer')",
		css: "body{}",
		icon: "<svg/>",
		pwa: {
			version: "rev",
			worker: "worker",
			manifest: "{}",
			files: new Map([
				[
					"/assets/rev/app.js",
					{ body: "shared-code", mime: "text/javascript" },
				],
			]),
		},
	});
	const bundle = await loadBundle(dir);
	expect(bundle.get("/")?.body.toString()).not.toContain('rel="manifest"');
	expect(bundle.get("/assets/rev/app.js")?.body.toString()).toBe("shared-code");
	expect(bundle.has("/sw.js")).toBe(false);
	await writeFile(
		join(dir, "manifest.json"),
		JSON.stringify({
			format: 1,
			files: [{ url: "/", file: "../../package.json", mime: "text/html" }],
		}),
	);
	await expect(loadBundle(dir)).rejects.toThrow();
});
