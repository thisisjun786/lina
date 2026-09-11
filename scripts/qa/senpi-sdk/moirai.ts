import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { parseArgs } from "node:util";
import { z } from "zod";
import manifest from "./package.json" with { type: "json" };

const { values } = parseArgs({
	options: { live: { type: "boolean" }, evidence: { type: "string" } },
	strict: true,
});
if (!values.live) throw new Error("LIVE_OPT_IN_REQUIRED");
if (!values.evidence || !isAbsolute(values.evidence))
	throw new Error("New absolute --evidence directory required");
const sdk = z
	.object({
		name: z.literal("@code-yeongyu/senpi"),
		version: z.literal(manifest.dependencies["@code-yeongyu/senpi"]),
	})
	.parse(
		JSON.parse(
			await readFile(
				new URL("../package.json", import.meta.resolve("@code-yeongyu/senpi")),
				"utf8",
			),
		),
	);
const { discoverOpenCodexConfig } = await import(
	"../../../packages/lina-opencodex/src/config.ts"
);
const connection = discoverOpenCodexConfig();
if (!connection.configured || !connection.origin || connection.error)
	throw new Error("Configured OpenCodex unavailable");
await mkdir(dirname(values.evidence), { recursive: true });
await mkdir(values.evidence, { mode: 0o700 });
const { MOIRAI_CASES } = await import("./moirai-cases.ts");
const { runMoiraiCase } = await import("./moirai-runner.ts");
const results = [];
for (const scenario of MOIRAI_CASES) {
	const result = await runMoiraiCase({
		scenario,
		upstreamBaseUrl: `${connection.origin}/v1`,
		evidenceDir: join(values.evidence, scenario.id),
		...(connection.admissionToken
			? { credential: connection.admissionToken }
			: {}),
	});
	results.push(result);
	console.log(`CASE_${result.complete ? "DONE" : "FAILED"} ${scenario.id}`);
}
const report = {
	sdk,
	model: "ollama-cloud/glm-5.3-flash",
	api: "openai-responses",
	runtime: { bun: Bun.version, platform: process.platform, arch: process.arch },
	cases: results,
};
const serialize = (value: unknown) => {
	const text = JSON.stringify(value, null, 2);
	return connection.admissionToken
		? text.replaceAll(connection.admissionToken, "[REDACTED]")
		: text;
};
await writeFile(
	join(values.evidence, "report.json"),
	`${serialize(report)}\n`,
	{ mode: 0o600 },
);
const transcript = [
	"# Five actual Senpi role cases",
	"Authored test conversations; module replies below are actual model outputs, not hypothetical examples.",
	...results.map((result, index) =>
		[
			`## ${index + 1}. ${result.title}`,
			`Case: ${result.id}; complete: ${result.complete}`,
			"### Input",
			...result.conversation.map((turn) => `${turn.speaker}: ${turn.text}`),
			...result.replies.map(
				(reply) =>
					`### ${reply.role}\nSession: ${reply.sessionId}\n\n\`\`\`\`text\n${reply.text}\n\`\`\`\``,
			),
		].join("\n\n"),
	),
].join("\n\n");
await writeFile(join(values.evidence, "transcript.md"), `${transcript}\n`, {
	mode: 0o600,
});
if (results.some((result) => !result.complete)) process.exitCode = 1;
