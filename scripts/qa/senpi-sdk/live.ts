import { mkdir } from "node:fs/promises";
import { dirname, isAbsolute } from "node:path";
import { parseArgs } from "node:util";

const { values } = parseArgs({
	options: { live: { type: "boolean" }, evidence: { type: "string" } },
	strict: true,
});
if (!values.live) throw new Error("LIVE_OPT_IN_REQUIRED");
if (!values.evidence || !isAbsolute(values.evidence))
	throw new Error("An absolute --evidence directory is required");
const { discoverOpenCodexConfig } = await import(
	"../../../packages/lina-opencodex/src/config.ts"
);
const connection = discoverOpenCodexConfig();
if (!connection.configured || !connection.origin || connection.error)
	throw new Error("Configured OpenCodex connection is unavailable");
await mkdir(dirname(values.evidence), { recursive: true });
const { runLiveScenario } = await import("./live-runner.ts");
const report = await runLiveScenario({
	upstreamBaseUrl: `${connection.origin}/v1`,
	evidenceDir: values.evidence,
	...(connection.admissionToken
		? { credential: connection.admissionToken }
		: {}),
});
const output = JSON.stringify(report);
console.log(
	connection.admissionToken
		? output.replaceAll(connection.admissionToken, "[REDACTED]")
		: output,
);
if (report.verdict !== "pass") process.exitCode = 1;
