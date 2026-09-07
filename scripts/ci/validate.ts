import { strict as assert } from "node:assert";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

function object(value: unknown): Record<string, unknown> {
	assert(
		value !== null && typeof value === "object" && !Array.isArray(value),
		"Expected an object",
	);
	return value as Record<string, unknown>;
}

function nonempty(value: unknown): asserts value is string {
	assert(
		typeof value === "string" && value.trim().length > 0,
		"Expected nonempty text",
	);
}

function validateSteps(value: unknown) {
	assert(Array.isArray(value) && value.length > 0, "Expected steps");
	for (const entry of value) {
		const step = object(entry);
		assert(
			step["continue-on-error"] === undefined,
			"Cannot ignore step failures",
		);
		if (step["uses"] !== undefined) {
			nonempty(step["uses"]);
			assert(
				/^\.\/\.github\/actions\/[a-z-]+$/.test(step["uses"]) ||
					/^[\w-]+\/[\w./-]+@[a-f0-9]{40}$/.test(step["uses"]),
				"Actions require full SHA pins",
			);
			if (step["uses"].startsWith("actions/checkout@")) {
				const options = object(step["with"]);
				assert(
					options["persist-credentials"] === false,
					"Do not persist checkout credentials",
				);
				assert(
					options["ref"] === undefined,
					"Test GitHub's merge candidate, not head-only checkout",
				);
			}
		}
	}
}

export function validateWorkflow(value: unknown) {
	const workflow = object(value);
	assert.deepEqual(
		workflow["permissions"],
		{ contents: "read" },
		"Use a read-only contents token",
	);
	const events = object(workflow["on"]);
	assert.deepEqual(
		Object.keys(events),
		["pull_request"],
		"Only pull_request is supported",
	);
	const pr = object(events["pull_request"]);
	assert.deepEqual(
		Object.keys(pr),
		["types"],
		"No branch or path filters on required CI",
	);
	assert(Array.isArray(pr["types"]), "Declare PR activity types");
	for (const event of ["opened", "reopened", "synchronize", "edited"])
		assert(pr["types"].includes(event), `Missing ${event} event`);
	const concurrency = object(workflow["concurrency"]);
	assert(concurrency["cancel-in-progress"] === true, "Cancel obsolete runs");
	const jobs = object(workflow["jobs"]);
	const required = ["changes", "lint", "types", "tests", "build"];
	assert.deepEqual(
		Object.keys(jobs).sort(),
		[...required, "dev-gate", "release-gate"].sort(),
		"Unexpected or missing CI job",
	);
	for (const [name, entry] of Object.entries(jobs)) {
		const job = object(entry);
		assert(
			job["runs-on"] === "ubuntu-24.04",
			"Use isolated hosted Ubuntu runners",
		);
		assert(
			typeof job["timeout-minutes"] === "number" &&
				job["timeout-minutes"] > 0 &&
				job["timeout-minutes"] <= 20,
			"Bound job timeout",
		);
		assert(
			job["continue-on-error"] === undefined,
			"Cannot ignore job failures",
		);
		assert(job["permissions"] === undefined, "Do not escalate job permissions");
		validateSteps(job["steps"]);
		if (name === "changes" || name === "tests") {
			const expected =
				name === "changes"
					? { id: "secret-scan", run: "bash scripts/ci/secrets.sh" }
					: { id: "dependency-audit", run: "bun scripts/ci/audit.ts" };
			const matches = (job["steps"] as unknown[]).filter(
				(step) => object(step)["id"] === expected.id,
			);
			assert.deepEqual(
				matches,
				[expected],
				"Security checks must run once with the exact unconditional command",
			);
		}
		if (name.endsWith("-gate")) {
			assert(Array.isArray(job["needs"]), "Gate needs all results");
			assert.deepEqual(
				[...job["needs"]].sort(),
				[...required].sort(),
				"Gate needs every required job",
			);
			assert(
				typeof job["if"] === "string" && /\balways\(\)/.test(job["if"]),
				"Gate must use always()",
			);
		} else if (name !== "changes") {
			assert.equal(
				job["needs"],
				"changes",
				"Independent jobs depend only on selection",
			);
		}
	}
}

export function validateForm(value: unknown) {
	const form = object(value);
	nonempty(form["name"]);
	nonempty(form["description"]);
	assert(
		Array.isArray(form["body"]) && form["body"].length > 0,
		"Form needs inputs",
	);
	const ids = new Set<string>();
	for (const entry of form["body"]) {
		const field = object(entry);
		const attributes = object(field["attributes"]);
		if (field["type"] === "markdown") {
			nonempty(attributes["value"]);
			continue;
		}
		assert(
			["input", "textarea", "dropdown", "checkboxes"].includes(
				String(field["type"]),
			),
			"Unsupported form field type",
		);
		const id = field["id"];
		assert(
			typeof id === "string" && /^[\w-]+$/.test(id) && !ids.has(id),
			"Field id must be valid and unique",
		);
		ids.add(id);
		nonempty(attributes["label"]);
		if (field["type"] === "dropdown" || field["type"] === "checkboxes") {
			assert(
				Array.isArray(attributes["options"]) &&
					attributes["options"].length > 0,
				"Choice field needs options",
			);
		}
		if (field["validations"] !== undefined)
			assert(
				typeof object(field["validations"])["required"] === "boolean",
				"required must be a boolean",
			);
	}
	assert(ids.size > 0, "Form needs an input");
}

function validateLinks(path: string) {
	const source = readFileSync(path, "utf8")
		.replace(/<!--[\s\S]*?-->/g, "")
		.replace(/```[\s\S]*?```/g, "");
	for (const match of source.matchAll(/\]\(([^\s)]+)\)/g)) {
		const target = match[1];
		if (target === undefined || /^(?:[a-z]+:|#)/i.test(target)) continue;
		const local = decodeURIComponent(target.split("#")[0] ?? "");
		assert(
			existsSync(resolve(dirname(path), local)),
			`${path}: missing link ${target}`,
		);
	}
}

if (import.meta.main) {
	const root = resolve(import.meta.dir, "../..");
	const yaml = (path: string): unknown =>
		Bun.YAML.parse(readFileSync(resolve(root, path), "utf8"));
	validateWorkflow(yaml(".github/workflows/ci.yml"));
	const action = object(yaml(".github/actions/setup/action.yml"));
	validateSteps(object(action["runs"])["steps"]);
	const forms = readdirSync(resolve(root, ".github/ISSUE_TEMPLATE")).filter(
		(name) => name.endsWith(".yml") && name !== "config.yml",
	);
	const names = new Set<unknown>();
	for (const file of forms) {
		const form = yaml(`.github/ISSUE_TEMPLATE/${file}`);
		validateForm(form);
		const name = object(form)["name"];
		assert(!names.has(name), "Issue form names must be unique");
		names.add(name);
	}
	assert.equal(forms.length, 4, "Expected four issue forms");
	const chooser = object(yaml(".github/ISSUE_TEMPLATE/config.yml"));
	assert.equal(typeof chooser["blank_issues_enabled"], "boolean");
	for (const file of ["POLICY.md", "CONTRIBUTING.md", "docs/CI.md"])
		validateLinks(resolve(root, file));
	assert.match(
		readFileSync(resolve(root, ".bun-version"), "utf8").trim(),
		/^\d+\.\d+\.\d+$/,
	);
	console.log(
		"CI workflow, setup action, four issue forms and contribution links validated.",
	);
}
