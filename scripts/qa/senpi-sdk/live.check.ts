import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { runLiveScenario } from "./live-runner.ts";
import { bounded } from "./protocol.ts";

type Variant =
	| "valid"
	| "east"
	| "receipt"
	| "quantity"
	| "json"
	| "model"
	| "missing-model";

function response(delta: unknown, variant: Variant, finish: string) {
	const model = variant === "model" ? "wrong-model" : "glm-5.3-flash";
	const fields = variant === "missing-model" ? {} : { model };
	const chunk = {
		...fields,
		id: "fixture-live",
		object: "chat.completion.chunk",
		created: 1,
		choices: [{ index: 0, delta, finish_reason: null }],
	};
	const complete = {
		...chunk,
		choices: [{ index: 0, delta: {}, finish_reason: finish }],
		usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
	};
	return new Response(
		`data: ${JSON.stringify(chunk)}\n\ndata: ${JSON.stringify(complete)}\n\ndata: [DONE]\n\n`,
		{ headers: { "content-type": "text/event-stream" } },
	);
}

async function exerciseLive(variant: Variant) {
	const root = await mkdtemp(join(tmpdir(), "senpi-live-check-"));
	let requests = 0;
	const upstream = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(request) {
			const body = z
				.object({
					messages: z.array(
						z.looseObject({ role: z.string(), content: z.unknown() }),
					),
				})
				.parse(await request.json());
			requests++;
			if (requests === 1)
				return response(
					{ role: "assistant", content: "I will wait." },
					variant,
					"stop",
				);
			if (requests === 2)
				return response(
					{
						role: "assistant",
						tool_calls: [
							{
								index: 0,
								id: "call_inventory",
								type: "function",
								function: {
									name: "lookup_inventory",
									arguments: JSON.stringify({
										warehouse: variant === "east" ? "east" : "west",
										sku: "BOLT",
									}),
								},
							},
						],
					},
					variant,
					"tool_calls",
				);
			if (requests !== 3) throw new Error("Unexpected extra fixture request");
			const toolText = z
				.string()
				.parse(body.messages.findLast((m) => m.role === "tool")?.content);
			const tool = z
				.object({
					warehouse: z.string(),
					sku: z.string(),
					quantity: z.number(),
					receipt: z.string(),
				})
				.parse(JSON.parse(toolText));
			let text = toolText;
			if (variant === "receipt")
				text = JSON.stringify({ ...tool, receipt: "forged" });
			if (variant === "quantity")
				text = JSON.stringify({ ...tool, quantity: -1 });
			if (variant === "json") text = "not JSON";
			return response({ role: "assistant", content: text }, variant, "stop");
		},
	});
	try {
		const report = await runLiveScenario({
			upstreamBaseUrl: `${upstream.url.origin}/v1`,
			evidenceDir: join(root, "evidence"),
		});
		expect(report.cleanup.sessionClosed).toBe(true);
		expect(report.cleanup.captureClosed).toBe(true);
		expect(report.cleanup.scratchRemoved).toBe(true);
		expect(existsSync(report.cleanup.scratch)).toBe(false);
		return report;
	} finally {
		await upstream.stop(true);
		await rm(root, { recursive: true, force: true });
	}
}

test("actual SDK applies the corrected lookup and returns independently held data", async () => {
	// Given a scripted provider but the actual SDK and a separate inventory owner.
	// When two user turns drive the tool loop.
	const report = await exerciseLive("valid");
	// Then the old selection never executes and truth enters only through the tool.
	expect(report.verdict).toBe("pass");
	expect(report.evidence.initialToolCalls).toBe(0);
	expect(report.evidence.calls).toEqual([report.truth]);
	expect(JSON.parse(report.evidence.finalText)).toEqual(report.truth);
	expect(report.evidence.wire).toHaveLength(3);
	expect(
		JSON.stringify(report.evidence.wire.slice(0, 2).map((r) => r.request)),
	).not.toContain(report.truth.receipt);
}, 30_000);

for (const variant of [
	"east",
	"receipt",
	"quantity",
	"json",
	"model",
	"missing-model",
] as const) {
	test(`actual SDK evidence rejects ${variant} corruption`, async () => {
		// Given one specific provider decision or evidence corruption.
		// When the same real SDK scenario runs through it.
		const report = await exerciseLive(variant);
		// Then a scripted final claim cannot override outside truth/model evidence.
		expect(report.verdict).toBe("fail");
	}, 30_000);
}

test("CLI refuses model execution without opt-in before creating evidence", async () => {
	// Given a trap endpoint and a fresh evidence path.
	const root = await mkdtemp(join(tmpdir(), "senpi-opt-in-"));
	let dispatches = 0;
	const trap = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch() {
			dispatches++;
			return new Response("unexpected", { status: 500 });
		},
	});
	const evidence = join(root, "evidence");
	const child = Bun.spawn(
		[process.execPath, "live.ts", "--evidence", evidence],
		{
			cwd: import.meta.dir,
			env: { ...process.env, LINA_OPENCODEX_BASE_URL: trap.url.origin },
			stdout: "pipe",
			stderr: "pipe",
		},
	);
	try {
		// When the real CLI is called without --live.
		const [code, , stderr] = await bounded(
			Promise.all([
				child.exited,
				new Response(child.stdout).text(),
				new Response(child.stderr).text(),
			]),
			"live opt-in refusal",
		);
		// Then the explicit permission error occurs before provider access or artifacts.
		expect(code).toBe(1);
		expect(stderr).toContain("LIVE_OPT_IN_REQUIRED");
		expect(dispatches).toBe(0);
		expect(existsSync(evidence)).toBe(false);
	} finally {
		child.kill();
		await child.exited;
		await trap.stop(true);
		await rm(root, { recursive: true, force: true });
	}
});
