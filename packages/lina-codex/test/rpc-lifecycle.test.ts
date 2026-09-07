import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { PassThrough } from "node:stream";
import { createCodexRpc } from "../src/rpc.ts";

test("RPC preserves UTF-8 split across pipe chunks", async () => {
	const input = new PassThrough(),
		output = new PassThrough();
	const rpc = await createCodexRpc({ stdio: { input, output } });
	let text = "";
	rpc.subscribe((_method, p) => {
		text = (p as { text: string }).text;
	});
	const bytes = Buffer.from(
		JSON.stringify({ method: "notice", params: { text: "노랑" } }) + "\n",
	);
	const cut = bytes.indexOf(Buffer.from("노")) + 1;
	output.write(bytes.subarray(0, cut));
	output.write(bytes.subarray(cut));
	expect(text).toBe("노랑");
	await rpc.close();
});

test("owned process shutdown stops descendants even when a launcher ignores TERM", async () => {
	const grandchild = 'process.on("SIGTERM",()=>{});setInterval(()=>{},1000)';
	const code = `const {spawn}=require("node:child_process");const c=spawn(process.execPath,["-e",${JSON.stringify(grandchild)}],{stdio:"ignore"});process.on("SIGTERM",()=>{});console.log(JSON.stringify({method:"ready",params:{pid:c.pid}}));setInterval(()=>{},1000)`;
	const rpc = await createCodexRpc({
		command: "node",
		args: ["-e", code],
		shutdownGraceMs: 50,
	});
	let pid = 0;
	await new Promise<void>((resolve) => {
		rpc.subscribe((method, params) => {
			if (method === "ready") {
				pid = (params as { pid: number }).pid;
				resolve();
			}
		});
	});
	await rpc.close();
	let running = false;
	try {
		running = readFileSync(`/proc/${pid}/stat`, "utf8").split(" ")[2] !== "Z";
	} catch {}
	if (running) {
		try {
			process.kill(pid, "SIGKILL");
		} catch {}
	}
	expect(running).toBe(false);
});

test("a throwing event consumer fails the RPC without uncaught stream exceptions", async () => {
	const input = new PassThrough(),
		output = new PassThrough();
	const rpc = await createCodexRpc({ stdio: { input, output } });
	const pending = rpc.request("pending");
	rpc.subscribe(() => {
		throw Error("disk full");
	});
	output.write(JSON.stringify({ method: "notice", params: {} }) + "\n");
	await expect(pending).rejects.toThrow();
	expect(rpc.closed).toBe(true);
	await rpc.close();
});
