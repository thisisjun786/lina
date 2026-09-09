import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { isAbsolute } from "node:path";
import type { HostEvidence } from "./score.ts";
import { HOST_IDS } from "./truth.ts";

export function validateHostEvidence(
	value: unknown,
	sourceHash: string,
): HostEvidence[] {
	if (
		!/^[a-f0-9]{64}$/.test(sourceHash) ||
		!Array.isArray(value) ||
		value.length !== HOST_IDS.length
	)
		throw Error("incomplete host evidence");
	const ids = new Set<string>();
	const names = new Set<string>();
	const result: HostEvidence[] = [];
	for (const entry of value) {
		if (!entry || typeof entry !== "object" || Array.isArray(entry))
			throw Error("invalid host receipt");
		const r = entry as Record<string, unknown>;
		if (
			Object.keys(r).sort().join() !==
			[
				"id",
				"sourceHash",
				"artifact",
				"artifactHash",
				"exitCode",
				"command",
				"testName",
			]
				.sort()
				.join()
		)
			throw Error("invalid host receipt fields");
		const { id, artifact, artifactHash, exitCode, command, testName } = r;
		if (
			typeof id !== "string" ||
			!HOST_IDS.includes(id) ||
			ids.has(id) ||
			r["sourceHash"] !== sourceHash ||
			exitCode !== 0 ||
			typeof artifact !== "string" ||
			!isAbsolute(artifact) ||
			typeof artifactHash !== "string" ||
			!/^[a-f0-9]{64}$/.test(artifactHash) ||
			typeof testName !== "string" ||
			!testName.includes(id) ||
			/[\r\n]/.test(testName) ||
			names.has(testName) ||
			!Array.isArray(command) ||
			!command.every((arg) => typeof arg === "string") ||
			command[0] !== "bun" ||
			command[1] !== "test" ||
			!command.includes("--test-name-pattern") ||
			command[command.indexOf("--test-name-pattern") + 1] !== testName
		)
			throw Error("invalid host execution receipt");
		const bytes = readFileSync(artifact);
		if (createHash("sha256").update(bytes).digest("hex") !== artifactHash)
			throw Error("host artifact hash mismatch");
		const lines = bytes.toString("utf8").split(/\r?\n/);
		const passLine = `(pass) ${testName}`;
		if (
			!lines.some(
				(line) => line === passLine || line.startsWith(`${passLine} [`),
			) ||
			!lines.some((line) => /^\s*0 fail\s*$/.test(line)) ||
			lines.some((line) => line.startsWith("(fail)"))
		)
			throw Error("missing successful host test output");
		ids.add(id);
		names.add(testName);
		result.push({ id, sourceHash, artifact, pass: true });
	}
	return result;
}
