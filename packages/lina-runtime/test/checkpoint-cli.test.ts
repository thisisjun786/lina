import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { checkpointCommand } from "../src/checkpoint-cli.ts";

test("offline checkpoint restores committed SQLite WAL after a writer crash", () => {
	const root = mkdtempSync(join(tmpdir(), "lina-wal-checkpoint-"));
	try {
		const home = join(root, "home");
		mkdirSync(join(home, "state"), { recursive: true });
		const dbPath = join(home, "state/memory.sqlite");
		const child = Bun.spawnSync([
			process.execPath,
			"-e",
			'import {DatabaseSync} from "node:sqlite"; const db=new DatabaseSync(process.argv[1]); db.exec("CREATE TABLE memory(value TEXT); PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; INSERT INTO memory VALUES (\'durable WAL memory\')"); process.kill(process.pid,"SIGKILL");',
			dbPath,
		]);
		expect(child.exitCode).not.toBe(0);
		expect(existsSync(dbPath + "-wal")).toBe(true);
		const env = { LINA_HOME: home };
		const checkpoint = checkpointCommand(
			"checkpoint",
			["create", "after crash"],
			env,
		) as { id: string };
		const target = join(root, "restored");
		checkpointCommand("restore", [checkpoint.id, target], env);
		const db = new DatabaseSync(join(target, "state/memory.sqlite"));
		try {
			expect(db.prepare("SELECT value FROM memory").get()?.["value"]).toBe(
				"durable WAL memory",
			);
		} finally {
			db.close();
		}
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("CLI checkpoints and stages all local persona, memory and settings databases", () => {
	const root = mkdtempSync(join(tmpdir(), "lina-checkpoint-cli-"));
	try {
		const home = join(root, "home");
		mkdirSync(join(home, "state"), { recursive: true });
		for (const name of ["agents", "mind", "models"]) {
			const db = new DatabaseSync(join(home, "state", `${name}.sqlite`));
			db.exec(
				"CREATE TABLE content(value TEXT); INSERT INTO content VALUES ('original')",
			);
			db.close();
		}
		const env: NodeJS.ProcessEnv = { ...process.env, LINA_HOME: home };
		delete env["LINA_STATE_DIR"];
		const run = (...args: string[]) => {
			const result = Bun.spawnSync(
				[
					process.execPath,
					resolve(import.meta.dir, "../scripts/lina.ts"),
					...args,
				],
				{ env, cwd: root },
			);
			if (result.exitCode) throw Error(result.stderr.toString());
			return JSON.parse(result.stdout.toString());
		};
		const checkpoint = run("checkpoint", "create", "before edits");
		expect(existsSync(join(home, "history/vcs"))).toBe(false);
		const gitCheckpoint = run(
			"checkpoint",
			"create",
			"--git",
			"optional metadata history",
		);
		expect(gitCheckpoint.reason).toBe("optional metadata history");
		if (Bun.which("git")) {
			const log = Bun.spawnSync([
				"git",
				"-C",
				join(home, "history/vcs"),
				"rev-list",
				"--count",
				"HEAD",
			]);
			expect(log.exitCode).toBe(0);
			expect(log.stdout.toString().trim()).toBe("1");
		}
		expect(checkpoint.complete).toBe(false);
		expect(
			checkpoint.files.map((file: { path: string }) => file.path).sort(),
		).toEqual(["agents.sqlite", "mind.sqlite", "models.sqlite"]);
		expect(run("checkpoint", "verify", checkpoint.id).id).toBe(checkpoint.id);
		const restored = join(root, "recovery");
		run("restore", checkpoint.id, restored);
		expect(existsSync(join(restored, "restore-review.json"))).toBe(true);
		for (const name of ["agents", "mind", "models"]) {
			const db = new DatabaseSync(join(restored, "state", `${name}.sqlite`), {
				readOnly: true,
			});
			expect(db.prepare("SELECT value FROM content").get()?.["value"]).toBe(
				"original",
			);
			db.close();
		}
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
