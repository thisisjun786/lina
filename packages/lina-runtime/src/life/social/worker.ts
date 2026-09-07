import { parseSocialResolveInput } from "../../../../lina-core/src/world/social-validation.ts";
import { executeSocialResolution } from "./execution.ts";
import { SOCIAL_PROCESS_LIMITS } from "./limits.ts";

async function readRequest(): Promise<string> {
	const chunks: Uint8Array[] = [];
	let size = 0;
	for await (const chunk of Bun.stdin.stream()) {
		size += chunk.byteLength;
		if (size > SOCIAL_PROCESS_LIMITS.maxBytes)
			throw Error("Social worker input limit");
		chunks.push(chunk);
	}
	return Buffer.concat(chunks).toString("utf8");
}
try {
	const input = parseSocialResolveInput(JSON.parse(await readRequest()));
	const result = JSON.stringify(executeSocialResolution(input));
	if (Buffer.byteLength(result) > input.limits.maxBytes)
		throw Error("Social worker output limit");
	process.stdout.write(result);
} catch (error) {
	// Internal worker diagnostic only: the parent drains bounded stderr and exposes no private details.
	process.stderr.write(
		error instanceof Error ? error.message : "Social worker failed",
	);
	process.exitCode = 1;
}
