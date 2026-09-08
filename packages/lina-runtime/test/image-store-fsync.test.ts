import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0))
		rmSync(root, { recursive: true, force: true });
});
test("repair1 post-rename fsync failure poisons the writer and reopen preserves the committed UUID", async () => {
	const root = mkdtempSync(join(tmpdir(), "lina-image-fsync-"));
	roots.push(root);
	// A child isolates the node:fs module fault from every other test/store.
	const script = `
 import assert from "node:assert/strict";
 import { randomUUID } from "node:crypto";
 import { mock } from "bun:test";
 import * as nativeFs from "node:fs";
 import { join } from "node:path";
 const fs={...nativeFs}; const root=${JSON.stringify(root)};const directory=join(root,"images");const path=join(directory,"jobs.json");
 let armed=false;let injected=false;
 mock.module("node:fs",()=>({...fs,fsyncSync(fd){if(armed&&!injected&&fs.fstatSync(fd).isDirectory()&&fs.readlinkSync("/proc/self/fd/"+fd)===directory){injected=true;throw Error("synthetic directory fsync failure");}fs.fsyncSync(fd);}}));
 const {ImageJobStore}=await import(${JSON.stringify(new URL("../src/images/store.ts", import.meta.url).href)});
 const binding={version:1,botId:"lina",sessionId:randomUUID(),sessionFile:join(root,"session.jsonl"),workspace:root};
 const input={requestId:"original-request",callId:"original-call",provider:"fixture",model:"image-one",prompt:"Synthetic image",sourceArtifactId:null};
 const store=new ImageJobStore(root,binding);armed=true;
 assert.throws(()=>store.create(input),/synthetic directory fsync failure/);assert.equal(injected,true);
 const committed=fs.readFileSync(path,"utf8");const raw=JSON.parse(committed);assert.equal(raw.jobs.length,1);
 for(const operation of [()=>store.create(input),()=>store.get(raw.jobs[0].id),()=>store.list(),()=>store.find(input),()=>store.usage(),()=>store.update(raw.jobs[0].id,{state:"cancelled"})]) assert.throws(operation,/unresolved|reopen|poison/i);
 assert.equal(fs.readFileSync(path,"utf8"),committed);
 const reopened=ImageJobStore.openExisting(root,binding);assert.equal(reopened.create(input).id,raw.jobs[0].id);assert.equal(reopened.list().length,1);
 console.log("Injected actual directory fsync failure after rename; poisoned retry refused; reopened UUID preserved.");
 `;
	const child = Bun.spawn([process.execPath, "--eval", script], {
		stdout: "pipe",
		stderr: "pipe",
	});
	const [exit, stdout, stderr] = await Promise.all([
		child.exited,
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
	]);
	if (exit !== 0) throw Error(stderr || stdout);
	expect(stdout).toContain("reopened UUID preserved");
	expect(exit).toBe(0);
});
