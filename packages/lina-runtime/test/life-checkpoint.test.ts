import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { hash } from "../../lina-core/src/attachments/validation.ts";
import { checkpointCommand } from "../src/checkpoint-cli.ts";
import { assertLifeImageJob } from "../src/images/life-authority.ts";
import { assertLifeImageHistory } from "../src/images/life-permissions.ts";
import {
	LIFE_CHECKPOINT_AGENT_ID,
	LIFE_CHECKPOINT_OWNER,
	LIFE_CHECKPOINT_PNG,
	LIFE_CHECKPOINT_WORLD_ID,
	type LifeCheckpointSnapshot,
	openLifeCheckpointOwners,
} from "./life-checkpoint-child.ts";

const childPath = fileURLToPath(
	new URL("./life-checkpoint-child.ts", import.meta.url),
);

async function readLine(stream: ReadableStream<Uint8Array>): Promise<string> {
	const reader = stream.getReader();
	const decoder = new TextDecoder();
	let text = "";
	try {
		while (!text.includes("\n")) {
			const chunk = await reader.read();
			if (chunk.done) throw Error("Child closed before its expected signal");
			text += decoder.decode(chunk.value, { stream: true });
		}
		return text.split("\n")[0] ?? "";
	} finally {
		reader.releaseLock();
	}
}

function spawnChild(home: string, mode: "seed" | "write" | "lease") {
	return Bun.spawn([process.execPath, childPath, home, mode], {
		stdin: "pipe",
		stdout: "pipe",
		stderr: "pipe",
	});
}

async function childMessage(
	child: ReturnType<typeof spawnChild>,
): Promise<unknown> {
	try {
		return JSON.parse(await readLine(child.stdout));
	} catch (error) {
		child.kill("SIGKILL");
		const stderr = await new Response(child.stderr).text();
		await child.exited;
		throw Error(
			(error instanceof Error ? error.message : String(error)) +
				"; stderr=" +
				stderr,
		);
	}
}

function envFor(home: string): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = { ...process.env, LINA_HOME: home };
	delete env["LINA_STATE_DIR"];
	return env;
}

function imageAssetPath(jobId: string): string {
	return (
		"life/images/" +
		LIFE_CHECKPOINT_WORLD_ID +
		"/" +
		LIFE_CHECKPOINT_AGENT_ID +
		"/assets/" +
		jobId
	);
}

function imageManifestPath(): string {
	return (
		"life/images/" +
		LIFE_CHECKPOINT_WORLD_ID +
		"/" +
		LIFE_CHECKPOINT_AGENT_ID +
		"/images/jobs.json"
	);
}

function imageArchivePath(jobId: string): string {
	return (
		"life/images/" +
		LIFE_CHECKPOINT_WORLD_ID +
		"/" +
		LIFE_CHECKPOINT_AGENT_ID +
		"/images/archives/" +
		jobId +
		".json"
	);
}

function assertRestoredOwners(
	stateRoot: string,
	snapshot: LifeCheckpointSnapshot,
) {
	const owners = openLifeCheckpointOwners(stateRoot);
	try {
		const worldId = LIFE_CHECKPOINT_WORLD_ID;
		expect(owners.world.snapshot(worldId).revision).toBe(
			snapshot.counts.worldRevision,
		);
		expect(owners.world.snapshot(worldId).revision).toBe(
			snapshot.worldRevision,
		);
		expect(owners.world.lifeSnapshot(worldId).revision).toBe(
			snapshot.lifeRevision,
		);
		expect(owners.world.lifeSnapshot(worldId).experiences).toHaveLength(
			snapshot.counts.lifeExperiences,
		);
		expect(owners.world.lifeInputs(worldId)).toHaveLength(
			snapshot.counts.lifeInputs,
		);
		expect(owners.world.lifeEffects(worldId)).toHaveLength(
			snapshot.counts.lifeEffects,
		);
		const receipt = owners.world.acceptLife(snapshot.commit, snapshot.identity);
		expect(receipt).toEqual({ ...snapshot.receipt, replayed: true });
		expect(receipt.eventId).toBe(snapshot.eventId);
		expect(receipt.worldRevision).toBe(snapshot.worldRevision);
		expect(receipt.lifeRevision).toBe(snapshot.lifeRevision);
		expect(owners.world.worldBinding(LIFE_CHECKPOINT_AGENT_ID)?.worldId).toBe(
			worldId,
		);
		expect(
			owners.agents
				.list()
				.map((profile) => profile.id)
				.sort(),
		).toEqual(["lina", "mira", "sol"]);
		expect(owners.agents.list()).toHaveLength(snapshot.counts.agents);
		expect(owners.agents.get("lina")?.revision).toBe(
			snapshot.agents.find((agent) => agent.id === "lina")?.revision,
		);
		const job = owners.images.get(snapshot.image.jobId);
		const linked = assertLifeImageJob(
			{ world: owners.world, agents: owners.agents, assertWorkCurrent() {} },
			job,
		);
		assertLifeImageHistory(
			{ world: owners.world, agents: owners.agents, assertWorkCurrent() {} },
			worldId,
			linked.intent.intentId,
		);
		expect(linked.attempt.attemptId).toBe(snapshot.image.attemptId);
		expect(
			owners.world.imageAttemptCount(worldId, snapshot.image.attemptId),
		).toMatchObject({ state: "attempted", terminal: "result", archived: true });
		expect(job.owner).toEqual(LIFE_CHECKPOINT_OWNER);
		expect(job.id).toBe(snapshot.image.jobId);
		expect(job.origin).toMatchObject({
			kind: "life",
			attemptId: snapshot.image.attemptId,
		});
		expect(owners.images.list()).toHaveLength(snapshot.counts.imageJobs);
		expect(job.artifact?.sha256).toBe(snapshot.image.sha256);
		expect(job.artifact?.size).toBe(snapshot.image.size);
		expect(job.delivery).toEqual({
			kind: "life",
			receiptId: snapshot.image.receiptId,
		});
		if (!job.artifact) throw Error("Restored image job lost its artifact");
		const bytes = owners.assets.bytes(job.artifact);
		expect(hash(bytes)).toBe(snapshot.image.sha256);
		expect(Buffer.from(bytes)).toEqual(Buffer.from(LIFE_CHECKPOINT_PNG));
	} finally {
		owners.close();
	}
}

test("checkpoint CLI refuses an active installation lease on LIFE state", async () => {
	const root = mkdtempSync(join(tmpdir(), "lina-life-checkpoint-lease-"));
	try {
		const home = join(root, "home");
		mkdirSync(join(home, "state"), { recursive: true });
		const env = envFor(home);
		const seeder = spawnChild(home, "seed");
		const seeded = (await childMessage(seeder)) as LifeCheckpointSnapshot;
		expect(await seeder.exited).toBe(0);
		expect(seeded.eventId).toBe("test-world:1");
		const lease = spawnChild(home, "lease");
		try {
			expect(await childMessage(lease)).toEqual({ mode: "lease" });
			expect(() =>
				checkpointCommand("checkpoint", ["create", "active fleet"], env),
			).toThrow(/busy|runtime/i);
		} finally {
			lease.stdin.end();
			expect(await lease.exited).toBe(0);
		}
		const checkpoint = checkpointCommand(
			"checkpoint",
			["create", "after fleet release"],
			env,
		) as {
			files: Array<{ path: string }>;
			exclusions: Array<{ reason: string; path: string }>;
		};
		const files = checkpoint.files.map((file) => file.path);
		expect(files).toContain("life/world.sqlite");
		expect(files).toContain("agents.sqlite");
		expect(files).toContain(imageManifestPath());
		expect(files).toContain(imageAssetPath(seeded.image.jobId));
		expect(files).toContain(imageArchivePath(seeded.image.jobId));
		expect(
			checkpoint.exclusions.some((item) => item.reason === "installation-lock"),
		).toBe(true);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("SIGKILL after a durable LIFE write leaves WAL and restore reopens matching owners", async () => {
	const root = mkdtempSync(join(tmpdir(), "lina-life-checkpoint-wal-"));
	try {
		const home = join(root, "home");
		mkdirSync(join(home, "state"), { recursive: true });
		const env = envFor(home);
		const child = spawnChild(home, "write");
		let snapshot: LifeCheckpointSnapshot;
		try {
			snapshot = (await childMessage(child)) as LifeCheckpointSnapshot;
			expect(snapshot.receipt.replayed).toBe(false);
			expect(snapshot.lifeRevision).toBe(1);
			expect(snapshot.counts.lifeInputs).toBeGreaterThan(0);
			expect(snapshot.counts.lifeEffects).toBeGreaterThan(0);
			child.kill("SIGKILL");
			expect(await child.exited).not.toBe(0);
		} finally {
			child.kill();
			await child.exited;
		}
		expect(existsSync(join(home, "state/life/world.sqlite-wal"))).toBe(true);
		const checkpoint = checkpointCommand(
			"checkpoint",
			["create", "after crash"],
			env,
		) as { id: string; files: Array<{ path: string }> };
		const files = checkpoint.files.map((file) => file.path);
		expect(files).toContain("life/world.sqlite");
		expect(files).toContain("life/world.sqlite-wal");
		expect(files).toContain("agents.sqlite");
		expect(files).toContain(imageManifestPath());
		expect(files).toContain(imageAssetPath(snapshot.image.jobId));
		expect(files).toContain(imageArchivePath(snapshot.image.jobId));
		const target = join(root, "restored");
		checkpointCommand("restore", [checkpoint.id, target], env);
		assertRestoredOwners(join(target, "state"), snapshot);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
