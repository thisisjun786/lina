import { expect, test } from "bun:test";
import { createCodexSession } from "../src/session.ts";
import { contextRpc } from "./context-policy-rpc.ts";
import { sourceFixture } from "./source-provenance-fixture.ts";

test("initial persona bootstrap keeps its original guard through exposure planning before thread/start", async () => {
	const f = sourceFixture(),
		rpc = contextRpc(f.root);
	let valid = true;
	let session: Awaited<ReturnType<typeof createCodexSession>> | undefined;
	try {
		const pending = createCodexSession({
			...f.options,
			contextPolicy: f.state.policy,
			rpc: rpc.options,
			bootstrapContext: () => ({
				systemPrompt: "FROZEN_LEARNED_BOOTSTRAP",
				beforeDeliver() {
					if (!valid) throw Error("Stale bootstrap proof");
				},
			}),
			contextExposure: (source) => {
				if (source.kind === "bootstrap") valid = false;
				return [];
			},
		});
		await expect(
			pending.then((value) => {
				session = value;
			}),
		).rejects.toThrow(/dispatch blocked|bootstrap proof/i);
		expect(
			rpc.frames.filter((frame) => frame.method === "thread/start"),
		).toHaveLength(0);
	} finally {
		await session?.close();
		rpc.close();
		await f.close();
	}
});
