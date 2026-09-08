import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { TaskStore } from "../src/task-store.ts";
import { createWorkManagementAuthority } from "../src/task-work-authority.ts";
import { required, workFixture } from "./task-work-fixture.ts";

test("source commit survives abrupt process exit before acknowledgement and replays identical request", () => {
	const f = workFixture();
	try {
		const script = `
   import {TaskStore} from ${JSON.stringify(new URL("../src/task-store.ts", import.meta.url).href)};
   import {createWorkManagementAuthority} from ${JSON.stringify(new URL("../src/task-work-authority.ts", import.meta.url).href)};
   const store=new TaskStore(${JSON.stringify(f.path)});
   store.createPending({id:"task",requestId:"create",ownerAgentId:"kai",title:"title",cwd:"/tmp",prompt:"synthetic",model:null,digest:"digest"});
   store.attachThread("task","native",null);
   store.completeTurn("task",{turnId:"turn",status:"running",messageId:"create"});
   store.applyNativeCompletion("task","turn","completed");
   const receipt=store.workReceipts("task")[0];
   store.shareWork("task",{receiptId:receipt.id,expectedPolicyRevision:0,requestId:"share",selection:{worldIds:["world"],categoryId:"explicit",shareOutcome:true,shareParticipants:false,summary:null}},createWorkManagementAuthority("local","kai"));
   process.exit(0);
  `;
		const child = spawnSync(process.execPath, ["--eval", script], {
			encoding: "utf8",
			timeout: 10000,
		});
		expect(child.status).toBe(0);
		expect(child.error).toBeUndefined();
		const store = new TaskStore(f.path);
		try {
			const receipt = required(store.workReceipts("task")[0]);
			const delivery = required(store.pendingWorkDeliveries()[0]);
			const replay = store.shareWork(
				"task",
				{
					receiptId: receipt.id,
					expectedPolicyRevision: 0,
					requestId: "share",
					selection: {
						worldIds: ["world"],
						categoryId: "explicit",
						shareOutcome: true,
						shareParticipants: false,
						summary: null,
					},
				},
				createWorkManagementAuthority("local", "kai"),
			);
			expect(replay.policyRevision).toBe(1);
			expect(store.pendingWorkDeliveries()).toEqual([delivery]);
			store.acknowledgeWorkDelivery(
				delivery.deliveryId,
				delivery.payloadDigest,
			);
			expect(store.pendingWorkDeliveries()).toEqual([]);
		} finally {
			store.close();
		}
		const final = new TaskStore(f.path);
		expect(final.workReceipts("task")).toHaveLength(1);
		expect(final.pendingWorkDeliveries()).toEqual([]);
		expect(final.workDeliveries()[0]?.status).toBe("delivered");
		final.close();
	} finally {
		f.close();
	}
});
