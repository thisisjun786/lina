/** Read-only proof using an installed plugin's credential resolver; secrets never enter evidence. */
import { createHash } from "node:crypto";
import { OpenVikingClient } from "../../packages/lina-memory/src/openviking/index.ts";

const pluginPath = process.env["LINA_QA_OV_PLUGIN"];
if (!pluginPath)
	throw Error(
		"LINA_QA_OV_PLUGIN must point to the installed plugin config.mjs",
	);
const plugin = await import(pluginPath);
const config = plugin.loadConfig();
if (typeof config.baseUrl !== "string" || typeof config.apiKey !== "string")
	throw Error("Installed OpenViking client is not configured");
const client = new OpenVikingClient({
	baseUrl: config.baseUrl,
	apiKey: config.apiKey,
	rootUri: "viking://resources",
});
const records: unknown[] = [];
const digest = (text: string) =>
	createHash("sha256").update(text).digest("hex");
try {
	const listed = await client.list(undefined, AbortSignal.timeout(8000));
	records.push({
		step: "list",
		root: listed.uri,
		entries: listed.entries.map((e) => ({ uri: e.uri, isDir: e.isDir })),
	});
	const candidates = [...listed.entries];
	let chosen: string | undefined;
	for (let index = 0; index < candidates.length && index < 12; index++) {
		const entry = candidates[index];
		if (!entry) break;
		if (!entry.isDir && /\.(md|txt)$/.test(entry.uri)) {
			chosen = entry.uri;
			break;
		}
		if (entry.isDir) {
			const child = await client.list(entry.uri, AbortSignal.timeout(8000));
			candidates.push(...child.entries);
		}
	}
	if (chosen) {
		const result = await client.read(chosen, 0, 5, AbortSignal.timeout(8000));
		const raw = await fetch(
			`${config.baseUrl}/api/v1/content/read?${new URLSearchParams({ uri: chosen, offset: "0", limit: "5" })}`,
			{
				headers: { "X-API-Key": config.apiKey },
				redirect: "manual",
				signal: AbortSignal.timeout(8000),
			},
		);
		const envelope = (await raw.json()) as { result: unknown };
		records.push({
			step: "read",
			uri: chosen,
			characters: result.content.length,
			sha256: digest(result.content),
			sameAsNative: envelope.result === result.content,
		});
	} else
		records.push({ step: "read", status: "no text file in bounded sample" });
} catch (error) {
	records.push({
		step: "error",
		message: error instanceof Error ? error.message : "unknown",
	});
	process.exitCode = 1;
}
await Bun.write(
	new URL(
		"../../devlog/_plan/260906_codex_runtime/054_openviking_live.json",
		import.meta.url,
	),
	JSON.stringify(records, null, 2) + "\n",
);
console.log(JSON.stringify(records));
