import { expect, test } from "bun:test";
import { join } from "node:path";

const script = join(import.meta.dir, "gate.ts");
const checks = ["lint", "types", "tests", "build"] as const;

function needs(app = "true", release = "false"): Record<string, unknown> {
	return {
		changes: { result: "success", outputs: { app, release } },
		lint: { result: "success" },
		types: { result: "success" },
		tests: { result: "success" },
		build: { result: "success" },
	};
}

function run(json: string | undefined, expected: string | undefined = "false") {
	const env: Record<string, string> = {};
	if (json !== undefined) env["NEEDS_JSON"] = json;
	if (expected !== undefined) env["EXPECTED_RELEASE"] = expected;
	return Bun.spawnSync([process.execPath, script], { env });
}

function expectFailure(
	value: unknown,
	reason: string,
	expected = "false",
): void {
	const result = run(JSON.stringify(value), expected);
	expect(result.exitCode).not.toBe(0);
	expect(result.stderr.toString()).toContain("[ci-gate]");
	expect(result.stderr.toString()).toContain(reason);
}

test.each(["false", "true"])(
	"all selected checks succeed for release=%s",
	(release) => {
		const result = run(JSON.stringify(needs("true", release)), release);
		expect(result.exitCode).toBe(0);
		expect(result.stderr.toString()).toBe("");
	},
);

test("docs-only accepts every combination of success and skipped", () => {
	for (let mask = 0; mask < 16; mask++) {
		const value = needs("false");
		checks.forEach((job, index) => {
			value[job] = { result: mask & (1 << index) ? "skipped" : "success" };
		});
		const result = run(JSON.stringify(value));
		expect(result.exitCode).toBe(0);
		expect(result.stderr.toString()).toBe("");
	}
});

for (const app of ["true", "false"]) {
	for (const job of ["changes", ...checks]) {
		test.each([
			"failure",
			"cancelled",
			"",
			"pending",
			"neutral",
			"timed_out",
			"Success",
		])(`app=${app} rejects ${job} result=%s`, (result) => {
			const value = needs(app);
			value[job] = { result, outputs: { app, release: "false" } };
			expectFailure(value, job);
		});
		test(`app=${app} rejects missing or malformed ${job}`, () => {
			for (const entry of [
				undefined,
				null,
				[],
				"success",
				{},
				{ result: true },
				{ result: null },
			]) {
				const value = needs(app);
				value[job] = entry;
				expectFailure(value, job);
			}
		});
	}
}

test.each(["changes", ...checks])(
	"selected job cannot be skipped: %s",
	(job) => {
		const value = needs();
		value[job] = {
			result: "skipped",
			outputs: { app: "true", release: "false" },
		};
		expectFailure(value, job);
	},
);

test("changes cannot be skipped on docs-only either", () => {
	const value = needs("false");
	value["changes"] = {
		result: "skipped",
		outputs: { app: "false", release: "false" },
	};
	expectFailure(value, "changes");
});

test.each(["app", "release"])(
	"selection output %s must be a literal boolean string",
	(key) => {
		for (const output of [
			undefined,
			null,
			true,
			false,
			0,
			1,
			[],
			{},
			"",
			"TRUE",
			"False",
			" false",
			"true\n",
		]) {
			const value = needs();
			value["changes"] = {
				result: "success",
				outputs: { app: "true", release: "false", [key]: output },
			};
			expectFailure(value, key);
		}
	},
);

test("missing or malformed changes outputs fail", () => {
	for (const outputs of [undefined, null, [], "true", {}]) {
		const value = needs();
		value["changes"] = { result: "success", outputs };
		expectFailure(value, "changes");
	}
});

test.each(["true", "false"])(
	"release output must equal EXPECTED_RELEASE=%s",
	(expected) => {
		expectFailure(
			needs("true", expected === "true" ? "false" : "true"),
			"release",
			expected,
		);
	},
);

test("release can never deselect application checks", () => {
	expectFailure(needs("false", "true"), "app", "true");
});

test.each([undefined, "", "TRUE", "False", "0", "1", "true\n", " false"])(
	"EXPECTED_RELEASE must be explicitly true or false: %j",
	(expected) => {
		// Pass an absent variable without the helper's development-gate default.
		const env = expected === undefined ? {} : { EXPECTED_RELEASE: expected };
		const result = Bun.spawnSync([process.execPath, script], {
			env: { NEEDS_JSON: JSON.stringify(needs()), ...env },
		});
		expect(result.exitCode).not.toBe(0);
		expect(result.stderr.toString()).toContain("[ci-gate]");
		expect(result.stderr.toString()).toContain("EXPECTED_RELEASE");
	},
);

test.each([undefined, "", "{", "null", "[]", "true", '"success"'])(
	"missing or malformed NEEDS_JSON fails: %j",
	(json) => {
		const result = run(json);
		expect(result.exitCode).not.toBe(0);
		expect(result.stderr.toString()).toContain("[ci-gate]");
		expect(result.stderr.toString()).toContain("NEEDS_JSON");
	},
);

test("unexpected jobs fail even when all known results succeed", () => {
	for (const extra of ["deploy", "typecheck", "constructor", "__proto__"]) {
		const value = { ...needs(), [extra]: { result: "success" } };
		expectFailure(value, extra);
	}
});

test("importing the gate does not execute the CLI", () => {
	const result = Bun.spawnSync(
		[
			process.execPath,
			"--eval",
			`await import(${JSON.stringify(script)}); console.log('imported')`,
		],
		{ env: {} },
	);
	expect(result.exitCode).toBe(0);
	expect(result.stdout.toString()).toBe("imported\n");
	expect(result.stderr.toString()).toBe("");
});
