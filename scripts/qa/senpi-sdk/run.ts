import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { startChild } from "./child.ts";
import { type Reply, startFixture } from "./fixture.ts";
import { initializeOwner } from "./owner.ts";
import { snapshotSchema } from "./protocol.ts";

export async function prepareRoot(root: string) {
	await mkdir(root);
	await Promise.all(
		["home", "workspace", "agent", "sessions", "tmp"].map((name) =>
			mkdir(join(root, name)),
		),
	);
	const ownerResult = `owner-${crypto.randomUUID()}`;
	await writeFile(join(root, "owner-value.txt"), ownerResult);
	await writeFile(join(root, "fenced.json"), "true");
	initializeOwner(root);
	return ownerResult;
}

export async function runFlow(root: string, correction = false) {
	const ownerResult = await prepareRoot(root);
	const replies: Reply[] = [
		{ kind: "tool", callId: "call_flow", operationId: "operation-flow" },
		{ kind: "text", text: "FLOW_DONE" },
	];
	if (correction) replies.push({ kind: "text", text: "CORRECTION_DONE" });
	const fixture = startFixture(root, replies);
	const child = startChild(root, fixture.endpoint);
	try {
		await child.ready;
		const completed = await child.prompt("QA_REQUEST=flow");
		let corrected: z.infer<typeof snapshotSchema> | undefined;
		if (correction) {
			const done = child.wait("done");
			child.send({ kind: "correct", policy: "new-policy" });
			corrected = snapshotSchema.parse(await done);
		}
		await child.close();
		const calls = (await readFile(join(root, "tool-calls.jsonl"), "utf8"))
			.trim()
			.split("\n");
		const finalMessage = completed.messages.at(-1);
		const content = z
			.array(z.object({ type: z.literal("text"), text: z.string() }))
			.parse(finalMessage?.content);
		return {
			name: correction ? "correction" : "flow",
			corrected,
			requests: fixture.requests,
			tool: { calls: calls.length, result: ownerResult },
			events: completed.events,
			final: content.map((part) => part.text).join(""),
			completed,
		};
	} finally {
		await child.kill();
		await fixture.close();
	}
}
