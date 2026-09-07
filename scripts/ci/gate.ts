const checks = ["lint", "types", "tests", "build"] as const;

function record(value: unknown, name: string): Record<string, unknown> {
	if (value === null || typeof value !== "object" || Array.isArray(value)) {
		throw Error(`${name} must be an object`);
	}
	// Validate the JSON container here; each field remains unknown until checked.
	return value as Record<string, unknown>;
}

function booleanOutput(value: unknown, name: string): boolean {
	if (value !== "true" && value !== "false") {
		throw Error(`${name} must be the literal string true or false`);
	}
	return value === "true";
}

function needsFromEnv(): Record<string, unknown> {
	const json = process.env["NEEDS_JSON"];
	if (!json) throw Error("NEEDS_JSON is required");
	let parsed: unknown;
	try {
		parsed = JSON.parse(json);
	} catch {
		throw Error("NEEDS_JSON must be valid JSON");
	}
	return record(parsed, "NEEDS_JSON");
}

function main(): void {
	const expectedRelease = booleanOutput(
		process.env["EXPECTED_RELEASE"],
		"EXPECTED_RELEASE",
	);
	const needs = needsFromEnv();
	const changes = record(needs["changes"], "changes");
	if (changes["result"] !== "success") throw Error("changes must succeed");
	const outputs = record(changes["outputs"], "changes.outputs");
	const app = booleanOutput(outputs["app"], "changes.outputs.app");
	const release = booleanOutput(outputs["release"], "changes.outputs.release");
	if (release !== expectedRelease)
		throw Error("release output does not match EXPECTED_RELEASE");
	if (release && !app) throw Error("release requires app=true");
	for (const job of checks) {
		const result = record(needs[job], job)["result"];
		if (result !== "success" && (app || result !== "skipped")) {
			throw Error(`${job} must ${app ? "succeed" : "succeed or be skipped"}`);
		}
	}
	const expectedJobs = new Set<string>(["changes", ...checks]);
	for (const job of Object.keys(needs)) {
		if (!expectedJobs.has(job)) throw Error(`Unexpected job: ${job}`);
	}
	console.log(`${release ? "release-gate" : "dev-gate"}: passed`);
}

if (import.meta.main) {
	try {
		main();
	} catch (error) {
		console.error(
			"[ci-gate]",
			error instanceof Error ? error.message : String(error),
		);
		process.exitCode = 1;
	}
}
