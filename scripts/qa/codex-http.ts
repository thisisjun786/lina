import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const fixture = JSON.parse(
	readFileSync(
		new URL(
			"../../devlog/_plan/260906_codex_runtime/043_browser_server.json",
			import.meta.url,
		),
		"utf8",
	),
) as { url: string };
const base = new URL(fixture.url);
assert.equal(base.hostname, "127.0.0.1");
const cases = [
	{ id: "hub", path: "/api/hub/status", expected: 200 },
	{ id: "models", path: "/api/models", expected: 200 },
	{ id: "tasks", path: "/api/tasks", expected: 200 },
	{ id: "unknown-task", path: "/api/tasks/missing-qa-task", expected: 404 },
	{
		id: "malformed-task",
		path: "/api/tasks",
		method: "POST",
		body: "{",
		expected: 400,
	},
	{
		id: "empty-task",
		path: "/api/tasks",
		method: "POST",
		body: "{}",
		expected: 400,
	},
	{
		id: "foreign-origin",
		path: "/api/tasks",
		origin: "https://untrusted.invalid",
		expected: 403,
	},
	{ id: "repeat-read", path: "/api/tasks", expected: 200 },
];
const output: string[] = [];
for (const scenario of cases) {
	const args = [
		"curl",
		"--silent",
		"--show-error",
		"--include",
		"--max-time",
		"10",
		new URL(scenario.path, base).href,
	];
	if (scenario.method) args.push("--request", scenario.method);
	if (scenario.body)
		args.push(
			"--header",
			"Content-Type: application/json",
			"--data-raw",
			scenario.body,
		);
	args.push("--header", `Origin: ${scenario.origin ?? base.origin}`);
	const child = Bun.spawn(args, { stdout: "pipe", stderr: "pipe" });
	const result = await new Response(child.stdout).text();
	assert.equal(await child.exited, 0, await new Response(child.stderr).text());
	const code = Number(/^HTTP\/\S+ (\d+)/.exec(result)?.[1]);
	output.push(
		JSON.stringify({
			scenario: scenario.id,
			command: args,
			expected: scenario.expected,
			actual: code,
		}),
		result,
	);
	assert.equal(code, scenario.expected, scenario.id);
}
await Bun.write(
	new URL(
		"../../devlog/_plan/260906_codex_runtime/091_http.txt",
		import.meta.url,
	),
	output.join("\n\n"),
);
console.log(`${cases.length} HTTP scenarios passed; no resources spawned`);
