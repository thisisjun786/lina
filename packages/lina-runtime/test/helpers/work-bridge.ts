import { createWorkManagementAuthority } from "../../../lina-codex/src/task-work-authority.ts";
import type { WorkSharingSelection } from "../../../lina-codex/src/task-work-types.ts";
import { TaskManager } from "../../../lina-codex/src/tasks.ts";
import { FakeCodexRpc } from "../../../lina-codex/test/task-fake-rpc.test.ts";
import {
	required,
	workFixture,
} from "../../../lina-codex/test/task-work-fixture.ts";
import { parseLifeConfigInput } from "../../../lina-core/src/world/authoring-request-validation.ts";
import type { WorkConfig } from "../../../lina-core/src/world/work-types.ts";
import { autonomyStoreFixture } from "../../../lina-core/test/life-autonomy-store-fixture.ts";

export { required };
export async function workBridgeFixture(configured = true) {
	const taskFiles = workFixture();
	const world = autonomyStoreFixture();
	const worldId = world.request.worldId;
	const rpc = new FakeCodexRpc();
	let tasks = new TaskManager({ path: taskFiles.path, rpc });
	const authority = createWorkManagementAuthority(
		"local-task-management",
		"lina",
	);
	const work: WorkConfig = {
		rules: [
			{
				id: "research",
				familyId: "meet",
				categoryId: "research",
				outcomes: [],
				attribution: "owner",
				weight: 1,
				requiredMatch: false,
			},
		],
	};
	function configure(value: WorkConfig | null) {
		const {
			worldId: _id,
			revision,
			...config
		} = world.store.lifeConfig(worldId);
		world.store.setLifeConfig(
			worldId,
			revision,
			parseLifeConfigInput({ ...config, version: 2, work: value }),
		);
	}
	if (configured) configure(work);
	const task = await tasks.create({
		ownerAgentId: "lina",
		title: "Private task title",
		cwd: taskFiles.cwd,
		prompt: "Private task prompt",
		requestId: "create-task",
	});
	const changed = Promise.withResolvers<void>();
	const off = tasks.subscribeWork(() => changed.resolve());
	rpc.completeTurn(required(task.threadId));
	await changed.promise;
	off();
	const receipt = required(tasks.workReceipts(task.id)[0]);
	const selection: WorkSharingSelection = {
		worldIds: [worldId],
		categoryId: "research",
		shareOutcome: true,
		shareParticipants: false,
		summary: null,
	};
	return {
		world,
		worldId,
		rpc,
		task,
		receipt,
		authority,
		selection,
		work,
		configure,
		taskPath: taskFiles.path,
		get tasks() {
			return tasks;
		},
		async share(value: WorkSharingSelection | null = selection) {
			const revision = tasks.workSharing(task.id, receipt.id).policyRevision;
			return tasks.shareWork(
				task.id,
				{
					receiptId: receipt.id,
					expectedPolicyRevision: revision,
					requestId: `share-${revision}`,
					selection: value,
				},
				authority,
			);
		},
		async reopenSource() {
			await tasks.close();
			tasks = new TaskManager({ path: taskFiles.path, rpc });
			await tasks.restore();
		},
		async close() {
			await tasks.close();
			world.close();
			taskFiles.close();
		},
	};
}
