import WebSocket from "ws";
import { z } from "zod";

/** Send one chat frame to Lina's intervention socket and print every frame until the matching ack. Usage: bun scripts/chat.ts <port> <text> */
const port = Number(process.argv[2]);
const text = process.argv.slice(3).join(" ");
if (!Number.isInteger(port) || text.length === 0) {
	console.error("usage: bun scripts/chat.ts <port> <text>");
	process.exit(2);
}

/** Only the fields this client dispatches on; every other field is printed raw. */
const FrameSchema = z.object({
	type: z.string(),
	id: z.string().optional(),
	message: z.string().optional(),
});

const id = crypto.randomUUID();
const ws = new WebSocket(`ws://127.0.0.1:${port}`);
let acked = false;

ws.on("message", (data) => {
	const raw = data.toString();
	console.log(`frame: ${raw}`);
	let json: unknown;
	try {
		json = JSON.parse(raw);
	} catch (error) {
		if (error instanceof SyntaxError) return;
		throw error;
	}
	const frame = FrameSchema.safeParse(json);
	if (!frame.success) return;
	if (frame.data.type === "error") {
		console.error(`error: ${frame.data.message ?? raw}`);
		process.exit(1);
	}
	if (frame.data.type === "ack" && frame.data.id === id) {
		acked = true;
		ws.close();
	}
});
ws.once("open", () => ws.send(JSON.stringify({ type: "chat", id, text })));
ws.once("close", () => process.exit(acked ? 0 : 1));
ws.once("error", (error: Error) => {
	console.error(`error: ${error.message}`);
	process.exit(1);
});
