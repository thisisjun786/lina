import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compareBatch } from "./compare.ts";
import { exportBatch } from "./scenario-export.ts";

test("comparison runs separate mode and scorer processes retaining each result", async () => {
	const root = mkdtempSync(join(tmpdir(), "compare-"));
	const server = Bun.serve({
		port: 0,
		fetch: () =>
			Response.json({
				model: "fixture",
				usage: { prompt_tokens: 1, completion_tokens: 1 },
				choices: [
					{
						message: {
							content: JSON.stringify({
								kind: "answer",
								purposeRevision: 1,
								text: JSON.stringify({
									outcome: "answer",
									value: "hello",
									missing: [],
									claims: [],
									verificationIds: [],
								}),
							}),
						},
					},
				],
			}),
	});
	try {
		const manifest = exportBatch("compare-dev", join(root, "cases"));
		manifest.episodes = manifest.episodes.filter(
			(e) => e.row === "B03" && e.variant === 0,
		);
		const path = join(root, "subset.json");
		writeFileSync(path, JSON.stringify(manifest));
		const report = await compareBatch(path, join(root, "result"), {
			...process.env,
			OLLAMA_BASE_URL: `http://localhost:${server.port}/v1`,
			OLLAMA_MODEL: "fixture",
			OLLAMA_API_KEY: "synthetic",
		});
		const started = JSON.parse(
			readFileSync(join(root, "result", "started.json"), "utf8"),
		);
		expect(typeof started.sourceHash).toBe("string");
		expect(started.model).toBe("fixture");
		expect(JSON.stringify(started)).not.toContain("synthetic");
		expect(report.trials).toHaveLength(3);
		expect(report.trials.every((t) => t.quality)).toBe(true);
		expect(report.qualification.qualified).toBe(false);
		expect(
			JSON.parse(readFileSync(join(root, "result", "report.json"), "utf8"))
				.trials,
		).toHaveLength(3);
	} finally {
		server.stop(true);
		rmSync(root, { recursive: true, force: true });
	}
});

test("comparison rejects truth changed while a model request is running", async () => {
	const root = mkdtempSync(join(tmpdir(), "compare-drift-"));
	const manifest = exportBatch("drift", join(root, "cases"));
	manifest.episodes = manifest.episodes.filter(
		(e) => e.row === "B03" && e.variant === 0,
	);
	const episode = manifest.episodes[0];
	if (!episode) throw Error("missing episode");
	const path = join(root, "subset.json");
	writeFileSync(path, JSON.stringify(manifest));
	let calls = 0;
	const server = Bun.serve({
		port: 0,
		fetch: () => {
			calls++;
			const truth = JSON.parse(readFileSync(episode.truthPath, "utf8"));
			truth.expected.value = "changed after dispatch";
			writeFileSync(episode.truthPath, JSON.stringify(truth));
			return Response.json({
				model: "fixture",
				usage: { prompt_tokens: 1, completion_tokens: 1 },
				choices: [
					{
						message: {
							content: JSON.stringify({
								kind: "answer",
								purposeRevision: 1,
								text: "hello",
							}),
						},
					},
				],
			});
		},
	});
	try {
		await expect(
			compareBatch(path, join(root, "result"), {
				...process.env,
				OLLAMA_BASE_URL: `http://localhost:${server.port}/v1`,
				OLLAMA_MODEL: "fixture",
				OLLAMA_API_KEY: "synthetic",
			}),
		).rejects.toThrow();
		expect(calls).toBe(1);
		expect(
			JSON.parse(readFileSync(join(root, "result", "invalidated.json"), "utf8"))
				.completedTrials,
		).toBe(0);
		expect(
			JSON.parse(readFileSync(join(root, "result", "report.json"), "utf8"))
				.qualification.qualified,
		).toBe(false);
		expect(
			JSON.parse(
				readFileSync(
					join(root, "result", episode.episodeId, "baseline", "trace.json"),
					"utf8",
				),
			).requests,
		).toHaveLength(1);
	} finally {
		server.stop(true);
		rmSync(root, { recursive: true, force: true });
	}
});
