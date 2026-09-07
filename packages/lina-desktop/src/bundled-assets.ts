import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { BundledAsset, BundledAssets } from "./broker.ts";

export async function loadBundle(directory: string): Promise<BundledAssets> {
	const manifest: unknown = JSON.parse(
		await readFile(join(directory, "manifest.json"), "utf8"),
	);
	if (
		!manifest ||
		typeof manifest !== "object" ||
		!("format" in manifest) ||
		manifest.format !== 1 ||
		!("files" in manifest) ||
		!Array.isArray(manifest.files)
	)
		throw Error("Invalid desktop bundle manifest");
	const assets = new Map<string, BundledAsset>();
	for (const item of manifest.files) {
		if (
			!item ||
			typeof item !== "object" ||
			typeof item.url !== "string" ||
			!/^\/(?:[a-zA-Z0-9/_.-]+)?$/.test(item.url) ||
			item.url.includes("..") ||
			typeof item.file !== "string" ||
			!/^[a-f0-9]{64}\.bin$/.test(item.file) ||
			typeof item.mime !== "string" ||
			/[\r\n]/.test(item.mime) ||
			assets.has(item.url)
		)
			throw Error("Invalid desktop bundle entry");
		const body = await readFile(join(directory, item.file));
		if (`${createHash("sha256").update(body).digest("hex")}.bin` !== item.file)
			throw Error("Desktop bundle checksum mismatch");
		assets.set(item.url, { body, mime: item.mime });
	}
	if (!assets.has("/")) throw Error("Desktop bundle is missing its page");
	return assets;
}
