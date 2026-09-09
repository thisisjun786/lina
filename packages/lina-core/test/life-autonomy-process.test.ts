import { expect, test } from "bun:test";
import { DatabaseSync } from "node:sqlite";
import { WorldStore } from "../src/world/store.ts";
import { autonomyStoreFixture } from "./life-autonomy-store-fixture.ts";

async function line(stream: ReadableStream<Uint8Array>): Promise<string> {
	const reader = stream.getReader();
	let value = "";
	try {
		while (!value.includes("\n")) {
			const part = await reader.read();
			if (part.done) throw Error("Child ended before signal");
			value += new TextDecoder().decode(part.value);
		}
		return value.split("\n")[0] ?? "";
	} finally {
		reader.releaseLock();
	}
}
const modulePath = new URL("../src/world/store.ts", import.meta.url).pathname;

test("SIGKILL after step preparation preserves the decision and permits one lease takeover", async () => {
	const f = autonomyStoreFixture();
	f.store.close();
	const child = Bun.spawn(
		[
			process.execPath,
			"--eval",
			`
import {WorldStore} from ${JSON.stringify(modulePath)};
const store=new WorldStore(${JSON.stringify(f.path)},()=>1000);
const step=store.prepareLifeStep(${JSON.stringify({ ...f.request, owner: "child" })},()=>42);
console.log(JSON.stringify({id:step.id,decision:step.decision,lease:step.lease}));
await Bun.stdin.text();
`,
		],
		{ stdin: "pipe", stdout: "pipe", stderr: "pipe" },
	);
	try {
		const prepared = JSON.parse(await line(child.stdout));
		child.kill("SIGKILL");
		await child.exited;
		f.advance(101);
		const reopened = new WorldStore(f.path, f.clock);
		try {
			const resumed = reopened.prepareLifeStep(f.request, () => {
				throw Error("Repeated entropy");
			});
			expect(resumed.id).toBe(prepared.id);
			expect(resumed.decision).toEqual(prepared.decision);
			expect(resumed.lease.token).toBe(prepared.lease.token + 1);
			expect(() =>
				reopened.finishLifeStep(prepared.lease, resumed.id, f.clock()),
			).toThrow(/lease/i);
			reopened.prepareLifeObservations(
				resumed.lease,
				resumed.id,
				null,
				f.clock(),
			);
			reopened.finishLifeStep(resumed.lease, resumed.id, f.clock());
			reopened.acceptLifeStep(
				resumed.lease,
				resumed.id,
				{ identity: f.source.identity, modelSettingsRevision: 1 },
				f.clock(),
			);
			expect(reopened.lifeSnapshot(resumed.worldId).revision).toBe(1);
		} finally {
			reopened.close();
		}
	} finally {
		child.kill();
		await child.exited;
		f.close();
	}
});

test("competing processes prepare one shared due-slot and one durable seed", async () => {
	const f = autonomyStoreFixture();
	f.store.close();
	const children = ["first", "second"].map((owner) =>
		Bun.spawn(
			[
				process.execPath,
				"--eval",
				`
import {WorldStore} from ${JSON.stringify(modulePath)};
const store=new WorldStore(${JSON.stringify(f.path)},()=>1000);
console.log("ready");await Bun.stdin.text();
try{const step=store.prepareLifeStep(${JSON.stringify({ ...f.request, owner })},()=>42);console.log(JSON.stringify({ok:true,id:step.id}));}
catch(error){console.log(JSON.stringify({ok:false,error:error.message}));}
finally{store.close();}
`,
			],
			{ stdin: "pipe", stdout: "pipe", stderr: "pipe" },
		),
	);
	try {
		expect(await Promise.all(children.map((c) => line(c.stdout)))).toEqual([
			"ready",
			"ready",
		]);
		for (const c of children) {
			c.stdin.write("go");
			c.stdin.end();
		}
		const results = await Promise.all(
			children.map(async (c) => {
				const result = JSON.parse(await line(c.stdout));
				expect(await c.exited).toBe(0);
				return result;
			}),
		);
		expect(results.filter((r) => r.ok)).toHaveLength(1);
		expect(results.find((r) => !r.ok)?.error).toMatch(/lease|busy/);
		const db = new DatabaseSync(f.path);
		try {
			expect(db.prepare("SELECT COUNT(*) AS n FROM life_steps").get()).toEqual({
				n: 1,
			});
			expect(
				db.prepare("SELECT COUNT(*) AS n FROM life_autonomy_state").get(),
			).toEqual({ n: 1 });
		} finally {
			db.close();
		}
	} finally {
		for (const child of children) {
			child.kill();
			await child.exited;
		}
		f.close();
	}
});
