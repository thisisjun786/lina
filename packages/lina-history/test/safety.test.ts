import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import {
	existsSync,
	linkSync,
	mkdirSync,
	readFileSync,
	renameSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import {
	createCheckpoint,
	restoreCheckpoint,
	verifyCheckpoint,
} from "../src/index.ts";
import { COVERAGE_GAPS, HistoryFixture } from "./fixture.ts";

function unsupported(error: unknown): boolean {
	return (
		error instanceof Error &&
		"code" in error &&
		(error.code === "EPERM" ||
			error.code === "ENOTSUP" ||
			error.code === "EACCES" ||
			error.code === "ENOSYS" ||
			error.code === "EOPNOTSUPP" ||
			error.code === "ENOENT")
	);
}

function makeFifo(path: string): void {
	const result = spawnSync("mkfifo", ["-m", "0600", path], {
		encoding: "utf8",
	});
	if (result.error) {
		const error: { message: string; code?: string } = result.error;
		throw Object.assign(new Error(error.message), { code: error.code });
	}
	if (result.status !== 0) {
		const message = result.stderr || result.stdout || "mkfifo failed";
		const code =
			/not supported|Operation not permitted|Function not implemented/i.test(
				message,
			)
				? "ENOTSUP"
				: "EINVAL";
		throw Object.assign(new Error(message), { code });
	}
}

function tryOp(label: string, op: () => void): boolean {
	try {
		op();
		return true;
	} catch (error) {
		if (unsupported(error)) return false;
		throw new Error(`${label}: ${String(error)}`);
	}
}

describe("lina-history safety", () => {
	let fixture: HistoryFixture;
	beforeEach(() => {
		fixture = new HistoryFixture();
	});
	afterEach(() => fixture.close());

	it("a crashed checkpoint writer does not leave history permanently locked", () => {
		mkdirSync(fixture.historyRoot, { recursive: true });
		const module = resolve(import.meta.dir, "../src/paths.ts");
		const child = Bun.spawnSync([
			process.execPath,
			"-e",
			'const {withHistoryLock}=await import(process.argv[1]);withHistoryLock(process.argv[2],()=>process.kill(process.pid,"SIGKILL"));',
			module,
			fixture.historyRoot,
		]);
		expect(child.exitCode).not.toBe(0);
		expect(capture().id).toMatch(/^chk_/);
	});

	function capture() {
		return createCheckpoint({
			historyRoot: fixture.historyRoot,
			components: [...fixture.components()],
			reason: "safety",
			coverageGaps: [...COVERAGE_GAPS],
		});
	}

	it("rejects a symlink inside a component", () => {
		const link = join(fixture.personaRoot, "alias.json");
		if (
			!tryOp("symlink", () =>
				symlinkSync(join(fixture.personaRoot, "persona.json"), link),
			)
		)
			return;
		expect(() => capture()).toThrow(/symlink/);
	});

	it("rejects a hardlinked binding file", () => {
		const source = join(fixture.personaRoot, "binding.json");
		writeFileSync(source, "{}");
		const alias = join(fixture.personaRoot, "binding-alias.json");
		if (!tryOp("hardlink", () => linkSync(source, alias))) return;
		expect(() => capture()).toThrow(/hardlink/);
	});

	it("rejects a special file", () => {
		const fifo = join(fixture.memoryRoot, "pipe.fifo");
		if (!tryOp("fifo", () => makeFifo(fifo))) return;
		expect(() => capture()).toThrow(/special/);
	});

	it("rejects traversal in component names and checkpoint ids", () => {
		expect(() =>
			createCheckpoint({
				historyRoot: fixture.historyRoot,
				components: [{ name: "../persona", root: fixture.personaRoot }],
				reason: "traverse",
			}),
		).toThrow(/invalid component name/);
		expect(() => verifyCheckpoint(fixture.historyRoot, "../chk_ab")).toThrow(
			/invalid checkpoint id/,
		);
		expect(() =>
			restoreCheckpoint(
				fixture.historyRoot,
				"chk_0123456789abcdef0123456789abcdef",
				join(fixture.dir, "out"),
			),
		).toThrow(/invalid checkpoint id|not found/);
	});

	it("rejects duplicate component names", () => {
		expect(() =>
			createCheckpoint({
				historyRoot: fixture.historyRoot,
				components: [
					{ name: "persona", root: fixture.personaRoot },
					{ name: "persona", root: fixture.memoryRoot },
				],
				reason: "dup",
			}),
		).toThrow(/duplicate component/);
	});

	it("rejects a history root nested inside a captured component", () => {
		expect(() =>
			createCheckpoint({
				historyRoot: join(fixture.memoryRoot, "history-nested"),
				components: [...fixture.components()],
				reason: "nested",
			}),
		).toThrow(/overlaps/);
	});

	it("rejects restoring onto an existing target without changing it", () => {
		const created = capture();
		mkdirSync(fixture.restoreTarget);
		const sentinel = join(fixture.restoreTarget, "sentinel");
		writeFileSync(sentinel, "keep");
		expect(() =>
			restoreCheckpoint(fixture.historyRoot, created.id, fixture.restoreTarget),
		).toThrow(/already exists/);
		expect(readFileSync(sentinel, "utf8")).toBe("keep");
	});

	it("rejects a symlink component root", () => {
		const linked = join(fixture.dir, "persona-link");
		if (!tryOp("symlink-root", () => symlinkSync(fixture.personaRoot, linked)))
			return;
		expect(() =>
			createCheckpoint({
				historyRoot: fixture.historyRoot,
				components: [{ name: "persona", root: linked }],
				reason: "link-root",
			}),
		).toThrow(/symlink|unsafe/);
	});

	it("rejects a corrupt manifest", () => {
		const created = capture();
		const manifest = join(
			fixture.historyRoot,
			"checkpoints",
			created.id,
			"manifest.json",
		);
		writeFileSync(manifest, "{not-json");
		expect(() => verifyCheckpoint(fixture.historyRoot, created.id)).toThrow(
			/corrupt/,
		);
	});

	it("marks a wal-only sqlite copy incomplete and still keeps the wal bytes", () => {
		const walOnly = join(fixture.dir, "wal-only");
		mkdirSync(walOnly);
		writeFileSync(join(walOnly, "orphan.sqlite-wal"), "wal-bytes");
		const created = createCheckpoint({
			historyRoot: fixture.historyRoot,
			components: [{ name: "memory", root: walOnly }],
			reason: "wal-only",
		});
		expect(created.complete).toBe(false);
		expect(created.coverageGaps.some((gap) => /wal/i.test(gap))).toBe(true);
		expect(
			created.files.some(
				(file) => file.path === "orphan.sqlite-wal" && file.size === 9,
			),
		).toBe(true);
	});
	it("rejects a tampered component that would restore outside the target", () => {
		const created = capture();
		const manifestPath = join(
			fixture.historyRoot,
			"checkpoints",
			created.id,
			"manifest.json",
		);
		const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
			files: Array<{ component: string; path: string }>;
		};
		const sample = manifest.files[0];
		if (!sample) throw new Error("expected captured file");
		sample.component = "../escape";
		writeFileSync(manifestPath, `${JSON.stringify(manifest)}\n`);
		expect(() => verifyCheckpoint(fixture.historyRoot, created.id)).toThrow(
			/corrupt|invalid/,
		);
		const target = join(fixture.dir, "restore-safe");
		expect(() =>
			restoreCheckpoint(fixture.historyRoot, created.id, target),
		).toThrow(/corrupt|invalid/);
		expect(existsSync(join(fixture.dir, "escape"))).toBe(false);
		expect(existsSync(target)).toBe(false);
	});

	it("never reports complete when coverage gaps or credentials are present", () => {
		const created = capture();
		const manifestPath = join(
			fixture.historyRoot,
			"checkpoints",
			created.id,
			"manifest.json",
		);
		const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
			complete: boolean;
			coverageGaps: string[];
		};
		manifest.complete = true;
		writeFileSync(manifestPath, `${JSON.stringify(manifest)}\n`);
		const verified = verifyCheckpoint(fixture.historyRoot, created.id);
		expect(verified.complete).toBe(false);
	});

	it("excludes generated codex-home config.toml as a credential", () => {
		mkdirSync(join(fixture.settingsRoot, "codex-home"));
		writeFileSync(
			join(fixture.settingsRoot, "codex-home", "config.toml"),
			'token = "admission"\n',
		);
		writeFileSync(join(fixture.settingsRoot, "other.toml"), "ok=1\n");
		const created = capture();
		expect(
			created.files.some((file) => file.path === "codex-home/config.toml"),
		).toBe(false);
		expect(
			created.exclusions.some(
				(item) =>
					item.path === "codex-home/config.toml" &&
					item.reason === "credential",
			),
		).toBe(true);
		expect(created.files.some((file) => file.path === "other.toml")).toBe(true);
		expect(created.files.some((file) => file.path === "settings.json")).toBe(
			true,
		);
		expect(created.complete).toBe(false);
	});

	it("rejects a symlink parent of a stored manifest", () => {
		const created = capture();
		const idDir = join(fixture.historyRoot, "checkpoints", created.id);
		const moved = join(fixture.dir, "moved-checkpoint");
		renameSync(idDir, moved);
		if (!tryOp("symlink-parent", () => symlinkSync(moved, idDir))) return;
		expect(() => verifyCheckpoint(fixture.historyRoot, created.id)).toThrow(
			/unsafe|symlink|corrupt/,
		);
	});
});
