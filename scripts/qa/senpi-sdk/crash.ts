import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { startChild } from "./child.ts";
import { startFixture } from "./fixture.ts";
import { readOwner } from "./owner.ts";
import { prepareRoot } from "./run.ts";

export async function runCrash(root: string, fenced: boolean) {
	await prepareRoot(root);
	await writeFile(join(root, "fenced.json"), JSON.stringify(fenced));
	const fixture = startFixture(root, [
		{ kind: "tool", callId: "call_flow", operationId: "operation-flow" },
		{ kind: "text", text: "FLOW_DONE" },
		{ kind: "tool", callId: "call_crash", operationId: "operation-crash" },
		{ kind: "tool", callId: "call_replay", operationId: "operation-crash" },
		{ kind: "text", text: "REPLAY_DONE" },
	]);
	const child = startChild(root, fixture.endpoint);
	try {
		await child.ready;
		const completed = await child.prompt("QA_REQUEST=flow");
		const committed = child.wait("effect");
		child.send({ kind: "crash" });
		const commitSignal = await committed;
		const killed = await child.kill();
		const before = readOwner(root);
		// Capture the exact killed-state JSONL separately before the reopened process can append.
		await writeFile(
			join(root, "killed-session.jsonl"),
			await readFile(completed.file),
		);
		const fresh = startChild(root, fixture.endpoint, completed.file);
		try {
			const reopened = await fresh.ready;
			const requestsAtOpen = fixture.requests.length;
			const replayed = await fresh.prompt("QA_REQUEST=explicit-replay");
			await fresh.close();
			return {
				name: fenced ? "crash-fenced" : "crash-unfenced",
				requests: fixture.requests,
				completed,
				commitSignal,
				killed,
				before,
				reopened,
				requestsAtOpen,
				replayed,
				after: readOwner(root),
				unfinished:
					!reopened.streaming && requestsAtOpen === 3
						? "pending-tool-not-resumed-on-open"
						: "unknown",
			};
		} finally {
			await fresh.kill();
		}
	} finally {
		await child.kill();
		await fixture.close();
	}
}
