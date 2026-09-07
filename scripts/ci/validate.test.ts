import { describe, expect, test } from "bun:test";
import { validateForm, validateWorkflow } from "./validate.ts";

const checkout = {
	uses: "actions/checkout@11d5960a326750d5838078e36cf38b85af677262",
	with: { "persist-credentials": false },
};

function workflow() {
	const selected = Object.fromEntries(
		["lint", "types", "tests", "build"].map((name) => [
			name,
			{
				"runs-on": "ubuntu-24.04",
				"timeout-minutes": 10,
				needs: "changes",
				if: "needs.changes.outputs.app == 'true'",
				steps: [
					structuredClone(checkout),
					...(name === "tests"
						? [{ id: "dependency-audit", run: "bun scripts/ci/audit.ts" }]
						: []),
				],
			},
		]),
	);
	const gate = {
		"runs-on": "ubuntu-24.04",
		"timeout-minutes": 5,
		needs: ["changes", "lint", "types", "tests", "build"],
		if: "always()",
		steps: [structuredClone(checkout)],
	};
	return {
		on: {
			pull_request: { types: ["opened", "reopened", "synchronize", "edited"] },
		},
		permissions: { contents: "read" },
		concurrency: {
			group: "ci-fixture-pr",
			"cancel-in-progress": true,
		},
		jobs: {
			changes: {
				"runs-on": "ubuntu-24.04",
				"timeout-minutes": 5,
				steps: [
					structuredClone(checkout),
					{ id: "secret-scan", run: "bash scripts/ci/secrets.sh" },
				],
			},
			...selected,
			"dev-gate": structuredClone(gate),
			"release-gate": structuredClone(gate),
		},
	};
}

describe("workflow safety contracts", () => {
	test("rejects missing or bypassed security checks", () => {
		for (const [jobName, id, run] of [
			["changes", "secret-scan", "bash scripts/ci/secrets.sh"],
			["tests", "dependency-audit", "bun scripts/ci/audit.ts"],
		] as const) {
			for (const extra of [
				undefined,
				{ if: "false" },
				{ run: `${run} || true` },
				{ shell: "bash {0}" },
				{ "continue-on-error": true },
				{ env: { GITLEAKS_CONFIG: "unchecked.toml" } },
			]) {
				const value = workflow();
				const jobs: Record<string, object> = value.jobs;
				const job = jobs[jobName];
				const steps = [
					structuredClone(checkout),
					...(extra === undefined ? [] : [{ id, run, ...extra }]),
				];
				expect(() =>
					validateWorkflow({
						...value,
						jobs: { ...value.jobs, [jobName]: { ...job, steps } },
					}),
				).toThrow();
			}
		}
	});
	test("accepts read-only hosted PR jobs and complete result aggregators", () => {
		expect(() => validateWorkflow(workflow())).not.toThrow();
	});
	test("rejects a missing aggregator dependency", () => {
		const value = workflow();
		value.jobs["release-gate"].needs.pop();
		expect(() => validateWorkflow(value)).toThrow("needs");
	});
	test("rejects a gate that would disappear on prerequisite failure", () => {
		const value = workflow();
		value.jobs["dev-gate"].if = "success()";
		expect(() => validateWorkflow(value)).toThrow("always()");
	});
	test("rejects privileged triggers, tokens and persistent runners", () => {
		expect(() =>
			validateWorkflow({ ...workflow(), on: { pull_request_target: {} } }),
		).toThrow();
		expect(() =>
			validateWorkflow({ ...workflow(), permissions: { contents: "write" } }),
		).toThrow();
		const value = workflow();
		value.jobs.changes["runs-on"] = "self-hosted";
		expect(() => validateWorkflow(value)).toThrow("hosted");
	});
	test("rejects workflow filters that can suppress required check publication", () => {
		const value = workflow();
		expect(() =>
			validateWorkflow({
				...value,
				on: { pull_request: { paths: ["packages/**"] } },
			}),
		).toThrow();
	});
	test("rejects floating Actions, persisted credentials, and PR head-only checkout", () => {
		for (const step of [
			{ ...checkout, uses: "actions/checkout@v4" },
			{ ...checkout, with: { "persist-credentials": true } },
			{
				...checkout,
				with: {
					"persist-credentials": false,
					ref: "topic-head",
				},
			},
		]) {
			const value = workflow();
			expect(() =>
				validateWorkflow({
					...value,
					jobs: {
						...value.jobs,
						changes: { ...value.jobs.changes, steps: [step] },
					},
				}),
			).toThrow();
		}
	});
	test("rejects ignored failures and job-level permission escalation", () => {
		const value = workflow();
		for (const extra of [
			{ "continue-on-error": true },
			{ permissions: { contents: "write" } },
		]) {
			expect(() =>
				validateWorkflow({
					...value,
					jobs: { ...value.jobs, changes: { ...value.jobs.changes, ...extra } },
				}),
			).toThrow();
		}
	});
});

describe("issue form structure", () => {
	const form = {
		name: "Bug report",
		description: "Report a reproducible defect.",
		body: [
			{
				type: "textarea",
				id: "reproduction",
				attributes: { label: "Reproduction" },
				validations: { required: true },
			},
		],
	};
	test("accepts a useful input and rejects malformed and duplicate IDs", () => {
		expect(() => validateForm(form)).not.toThrow();
		expect(() =>
			validateForm({ ...form, body: [...form.body, ...form.body] }),
		).toThrow("id");
		expect(() => validateForm({ ...form, body: [] })).toThrow();
		expect(() =>
			validateForm({
				...form,
				body: [
					{ type: "textarea", id: "bad id", attributes: { label: "Text" } },
				],
			}),
		).toThrow();
	});
	test("rejects dropdowns without choices", () => {
		expect(() =>
			validateForm({
				...form,
				body: [
					{
						type: "dropdown",
						id: "area",
						attributes: { label: "Area", options: [] },
					},
				],
			}),
		).toThrow();
	});
});
