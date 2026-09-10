import { startChild } from "./child.ts";
import { startFixture } from "./fixture.ts";
import { bounded, snapshotSchema } from "./protocol.ts";
import { prepareRoot } from "./run.ts";

export async function runRecovery(root: string) {
	await prepareRoot(root);
	const fixture = startFixture(root, [
		{ kind: "tool", callId: "call_flow", operationId: "operation-flow" },
		{ kind: "text", text: "FLOW_DONE" },
		{ kind: "hold" },
		{ kind: "text", text: "REOPENED_DONE" },
	]);
	const child = startChild(root, fixture.endpoint);
	try {
		await child.ready;
		const completed = await child.prompt("QA_REQUEST=flow");
		const done = child.wait("done");
		child.send({ kind: "prompt", text: "QA_REQUEST=hold" });
		const heldRequest = await bounded(fixture.held, "held HTTP request");
		const abortAck = child.wait("aborted");
		child.send({ kind: "abort" });
		const [abortedValue, , disconnectedRequest] = await Promise.all([
			done,
			abortAck,
			bounded(fixture.disconnected, "HTTP cancellation"),
		]);
		const aborted = snapshotSchema.parse(abortedValue);
		await child.close();
		const fresh = startChild(root, fixture.endpoint, completed.file);
		try {
			const reopened = await fresh.ready;
			const requestsAtOpen = fixture.requests.length;
			const continued = await fresh.prompt("QA_REQUEST=reopened");
			await fresh.close();
			const interrupted =
				aborted.messages.at(-1)?.stopReason === "aborted" &&
				!reopened.streaming &&
				requestsAtOpen === 3;
			const unfinished = interrupted
				? "interrupted-not-resumed-on-open"
				: "unknown";
			return {
				name: "recovery",
				requests: fixture.requests,
				completed,
				aborted,
				reopened,
				continued,
				heldRequest,
				disconnectedRequest,
				requestsAtOpen,
				unfinished,
			};
		} finally {
			await fresh.kill();
		}
	} finally {
		await child.kill();
		await fixture.close();
	}
}
