import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import {
	chmodSync,
	existsSync,
	lstatSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
	CALLER_BARRIER_WARNING,
	createCheckpoint,
	diffCheckpoints,
	listCheckpoints,
	REVIEW_MARKER,
	restoreCheckpoint,
	verifyCheckpoint,
} from "../src/index.ts";
import { COVERAGE_GAPS, HistoryFixture } from "./fixture.ts";

const EXCLUDED_RELATIVE = [
	"persona/owner.sqlite",
	"persona/owner.sqlite-wal",
	"persona/owner.sqlite-shm",
	"memory/session.jsonl.lina-lease.sqlite",
	"memory/session.jsonl.lina-lease.sqlite-wal",
	"memory/session.jsonl.lina-lease.sqlite-shm",
	"memory/memory.sqlite-shm",
	"settings/installation-lock.sqlite",
	"settings/installation-lock.sqlite-wal",
	"settings/installation-lock.sqlite-shm",
	"settings/installation-lock.sqlite-journal",
	"settings/.env",
	"settings/credentials.json",
	"settings/auth.json",
] as const;

describe("lina-history checkpoints", () => {
	let fixture: HistoryFixture;
	beforeEach(() => {
		fixture = new HistoryFixture();
	});
	afterEach(() => fixture.close());

	it("round-trips persona, memory and settings with wal bytes and recorded coverage", () => {
		const created = createCheckpoint({
			historyRoot: fixture.historyRoot,
			components: [...fixture.components()],
			reason: "installable-lina-fixture",
			coverageGaps: [...COVERAGE_GAPS],
		});
		expect(created.id).toMatch(/^chk_[0-9a-f]{32}$/);
		expect(created.version).toBe(1);
		expect(created.complete).toBe(false);
		expect(created.coverageGaps).toEqual([
			...COVERAGE_GAPS,
			"credentials were excluded and must be reauthenticated",
		]);
		expect(created.warnings).toContain(CALLER_BARRIER_WARNING);
		expect(
			created.files.map((file) => `${file.component}/${file.path}`).sort(),
		).toEqual(
			[
				"memory/memory.sqlite",
				"memory/memory.sqlite-wal",
				"persona/persona.json",
				"settings/prompts/custom.txt",
				"settings/settings.json",
			].sort(),
		);
		for (const file of created.files) {
			expect(file.hash).toMatch(/^[0-9a-f]{64}$/);
			expect(file.size).toBeGreaterThan(0);
			expect(file.mtime).toMatch(/^\d{4}-\d{2}-\d{2}T/);
			expect(file.path.includes("..")).toBe(false);
			expect(/^[A-Za-z0-9._/-]+$/.test(file.path)).toBe(true);
		}
		expect(
			created.exclusions.map((item) => `${item.component}/${item.path}`).sort(),
		).toEqual([...EXCLUDED_RELATIVE].sort());
		expect(
			created.exclusions.some((item) => item.reason === "credential"),
		).toBe(true);
		expect(created.exclusions.some((item) => item.reason === "lease")).toBe(
			true,
		);
		expect(
			created.exclusions.some((item) => item.reason === "installation-lock"),
		).toBe(true);
		expect(
			created.exclusions.some(
				(item) =>
					item.reason === "regenerable" && item.path === "memory.sqlite-shm",
			),
		).toBe(true);

		const listed = listCheckpoints(fixture.historyRoot);
		expect(listed).toHaveLength(1);
		expect(listed[0]?.id).toBe(created.id);
		expect(listed[0]?.reason).toBe("installable-lina-fixture");
		expect(listed[0]?.complete).toBe(false);
		expect(listed[0]?.coverageGaps).toEqual(created.coverageGaps);

		const verified = verifyCheckpoint(fixture.historyRoot, created.id);
		expect(verified.id).toBe(created.id);
		expect(verified.files).toEqual(created.files);
		expect(verified.coverageGaps).toEqual(created.coverageGaps);

		const restored = restoreCheckpoint(
			fixture.historyRoot,
			created.id,
			fixture.restoreTarget,
		);
		expect(restored.checkpointId).toBe(created.id);
		expect(restored.complete).toBe(false);
		expect(restored.coverageGaps).toEqual(created.coverageGaps);
		expect(restored.reviewMarker).toBe(
			join(fixture.restoreTarget, REVIEW_MARKER),
		);
		expect(
			readFileSync(join(fixture.restoreTarget, "persona", "persona.json")),
		).toEqual(readFileSync(join(fixture.personaRoot, "persona.json")));
		expect(
			readFileSync(join(fixture.restoreTarget, "memory", "memory.sqlite")),
		).toEqual(readFileSync(join(fixture.memoryRoot, "memory.sqlite")));
		expect(
			readFileSync(join(fixture.restoreTarget, "memory", "memory.sqlite-wal")),
		).toEqual(readFileSync(join(fixture.memoryRoot, "memory.sqlite-wal")));
		expect(
			readFileSync(join(fixture.restoreTarget, "settings", "settings.json")),
		).toEqual(readFileSync(join(fixture.settingsRoot, "settings.json")));
		expect(
			readFileSync(
				join(fixture.restoreTarget, "settings", "prompts", "custom.txt"),
			),
		).toEqual(
			readFileSync(join(fixture.settingsRoot, "prompts", "custom.txt")),
		);
		for (const relative of EXCLUDED_RELATIVE) {
			expect(existsSync(join(fixture.restoreTarget, relative))).toBe(false);
		}
		const review = JSON.parse(
			readFileSync(join(fixture.restoreTarget, REVIEW_MARKER), "utf8"),
		) as {
			startable: boolean;
			reviewRequired: boolean;
			checkpointId: string;
			coverageGaps: string[];
			warnings: string[];
		};
		expect(review.startable).toBe(false);
		expect(review.reviewRequired).toBe(true);
		expect(review.checkpointId).toBe(created.id);
		expect(review.coverageGaps).toEqual(created.coverageGaps);
		expect(review.warnings).toContain(CALLER_BARRIER_WARNING);
		expect(existsSync(join(fixture.personaRoot, "owner.sqlite"))).toBe(true);
		expect(existsSync(join(fixture.settingsRoot, ".env"))).toBe(true);
		if (process.platform !== "win32") {
			expect(lstatSync(fixture.historyRoot).mode & 0o777).toBe(0o700);
			expect(
				lstatSync(join(fixture.restoreTarget, "persona", "persona.json")).mode &
					0o777,
			).toBe(0o600);
			expect(lstatSync(fixture.restoreTarget).mode & 0o777).toBe(0o700);
		}
	});

	it("diffs a later mutated settings checkpoint against the original", () => {
		const left = createCheckpoint({
			historyRoot: fixture.historyRoot,
			components: [...fixture.components()],
			reason: "before",
			coverageGaps: [...COVERAGE_GAPS],
		});
		writeFileSync(
			join(fixture.settingsRoot, "settings.json"),
			'{"model":"grok-4.6","role":"reviewer"}\n',
			{ mode: 0o600 },
		);
		const right = createCheckpoint({
			historyRoot: fixture.historyRoot,
			components: [...fixture.components()],
			reason: "after",
			coverageGaps: [...COVERAGE_GAPS],
		});
		const diff = diffCheckpoints(fixture.historyRoot, left.id, right.id);
		expect(diff.left).toBe(left.id);
		expect(diff.right).toBe(right.id);
		expect(diff.added).toEqual([]);
		expect(diff.removed).toEqual([]);
		const leftHash =
			left.files.find((file) => file.path === "settings.json")?.hash ?? "";
		const rightHash =
			right.files.find((file) => file.path === "settings.json")?.hash ?? "";
		expect(diff.changed).toEqual([
			{
				component: "settings",
				path: "settings.json",
				leftHash,
				rightHash,
			},
		]);
		expect(leftHash).not.toBe(rightHash);
		expect(
			listCheckpoints(fixture.historyRoot)
				.map((item) => item.id)
				.sort(),
		).toEqual([left.id, right.id].sort());
	});

	it("rejects a corrupt object and does not restore it", () => {
		const created = createCheckpoint({
			historyRoot: fixture.historyRoot,
			components: [...fixture.components()],
			reason: "corrupt-object",
			coverageGaps: [...COVERAGE_GAPS],
		});
		const sample = created.files[0];
		if (!sample) throw new Error("expected captured file");
		const objectPath = join(
			fixture.historyRoot,
			"objects",
			sample.hash.slice(0, 2),
			sample.hash.slice(2),
		);
		chmodSync(objectPath, 0o600);
		writeFileSync(objectPath, "x".repeat(sample.size), { mode: 0o600 });
		expect(() => verifyCheckpoint(fixture.historyRoot, created.id)).toThrow(
			/corrupt/,
		);
		expect(() =>
			restoreCheckpoint(fixture.historyRoot, created.id, fixture.restoreTarget),
		).toThrow(/corrupt/);
		expect(existsSync(fixture.restoreTarget)).toBe(false);
	});

	it("records coverage gaps and never labels an incomplete snapshot as a full backup", () => {
		const created = createCheckpoint({
			historyRoot: fixture.historyRoot,
			components: [...fixture.components()],
			reason: "gaps",
			coverageGaps: [...COVERAGE_GAPS],
		});
		expect(created.complete).toBe(false);
		expect(JSON.stringify(created).toLowerCase()).not.toContain("full backup");
		const reviewTarget = join(fixture.dir, "review-only");
		restoreCheckpoint(fixture.historyRoot, created.id, reviewTarget);
		const review = JSON.parse(
			readFileSync(join(reviewTarget, REVIEW_MARKER), "utf8"),
		) as { complete: boolean; startable: boolean };
		expect(review.complete).toBe(false);
		expect(review.startable).toBe(false);
	});
	it("does not write a git export unless exportGit is set", () => {
		createCheckpoint({
			historyRoot: fixture.historyRoot,
			components: [...fixture.components()],
			reason: "no-git",
			coverageGaps: [...COVERAGE_GAPS],
		});
		expect(existsSync(join(fixture.historyRoot, "vcs"))).toBe(false);
	});

	it("exports only the current metadata manifest when exportGit is set", () => {
		const previousGitDir = process.env["GIT_DIR"];
		process.env["GIT_DIR"] = join(fixture.dir, "unrelated.git");
		try {
			const created = createCheckpoint({
				historyRoot: fixture.historyRoot,
				components: [...fixture.components()],
				reason: "git-export",
				coverageGaps: [...COVERAGE_GAPS],
				exportGit: true,
			});
			const manifestPath = join(
				fixture.historyRoot,
				"vcs",
				"manifests",
				`${created.id}.json`,
			);
			expect(existsSync(manifestPath)).toBe(true);
			const exported = readFileSync(manifestPath, "utf8");
			expect(exported).not.toContain("memory-main");
			expect(exported).not.toContain("SECRET=");
			expect(exported).not.toContain("should-not-copy");
			expect(existsSync(join(fixture.historyRoot, "vcs", "objects"))).toBe(
				false,
			);
			if (created.warnings.includes("git manifest export skipped")) return;
			const env = { ...process.env };
			delete env["GIT_DIR"];
			const listed = spawnSync(
				"git",
				["-C", join(fixture.historyRoot, "vcs"), "ls-files"],
				{ encoding: "utf8", env },
			);
			expect(listed.status).toBe(0);
			expect(listed.stdout.trim()).toBe(`manifests/${created.id}.json`);
		} finally {
			if (previousGitDir === undefined) delete process.env["GIT_DIR"];
			else process.env["GIT_DIR"] = previousGitDir;
		}
	});
	it("commits only the current manifest even if other vcs files are staged", () => {
		const first = createCheckpoint({
			historyRoot: fixture.historyRoot,
			components: [...fixture.components()],
			reason: "git-first",
			coverageGaps: [...COVERAGE_GAPS],
			exportGit: true,
		});
		if (first.warnings.includes("git manifest export skipped")) return;
		const vcs = join(fixture.historyRoot, "vcs");
		writeFileSync(join(vcs, "payload.bin"), "memory-main-should-not-commit");
		const env = { ...process.env };
		delete env["GIT_DIR"];
		const staged = spawnSync("git", ["-C", vcs, "add", "--", "payload.bin"], {
			encoding: "utf8",
			env,
		});
		expect(staged.status).toBe(0);
		writeFileSync(
			join(fixture.settingsRoot, "settings.json"),
			'{"model":"grok-4.6","role":"after-git"}\n',
			{ mode: 0o600 },
		);
		const second = createCheckpoint({
			historyRoot: fixture.historyRoot,
			components: [...fixture.components()],
			reason: "git-second",
			coverageGaps: [...COVERAGE_GAPS],
			exportGit: true,
		});
		if (second.warnings.includes("git manifest export skipped")) return;
		const shown = spawnSync(
			"git",
			["-C", vcs, "show", "--pretty=format:", "--name-only", "HEAD"],
			{ encoding: "utf8", env },
		);
		expect(shown.status).toBe(0);
		expect(shown.stdout.trim()).toBe(`manifests/${second.id}.json`);
		expect(shown.stdout).not.toContain("payload.bin");
	});
});
