import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export class HistoryFixture {
	readonly dir = mkdtempSync(join(tmpdir(), "lina-history-"));
	readonly historyRoot = join(this.dir, "history");
	readonly personaRoot = join(this.dir, "install", "persona");
	readonly memoryRoot = join(this.dir, "install", "memory");
	readonly settingsRoot = join(this.dir, "install", "settings");
	readonly restoreTarget = join(this.dir, "restore-target");

	constructor() {
		this.seed();
	}

	components() {
		return [
			{ name: "persona", root: this.personaRoot },
			{ name: "memory", root: this.memoryRoot },
			{ name: "settings", root: this.settingsRoot },
		] as const;
	}

	seed(): void {
		mkdirSync(join(this.settingsRoot, "prompts"), {
			recursive: true,
			mode: 0o700,
		});
		mkdirSync(this.personaRoot, { recursive: true, mode: 0o700 });
		mkdirSync(this.memoryRoot, { recursive: true, mode: 0o700 });
		writePrivate(
			join(this.personaRoot, "persona.json"),
			'{"id":"lina","voice":"calm"}\n',
		);
		writePrivate(join(this.personaRoot, "owner.sqlite"), "lease-owner");
		writePrivate(join(this.personaRoot, "owner.sqlite-wal"), "lease-owner-wal");
		writePrivate(join(this.personaRoot, "owner.sqlite-shm"), "lease-owner-shm");
		writePrivate(join(this.memoryRoot, "memory.sqlite"), "memory-main");
		writePrivate(join(this.memoryRoot, "memory.sqlite-wal"), "memory-wal");
		writePrivate(join(this.memoryRoot, "memory.sqlite-shm"), "memory-shm");
		writePrivate(
			join(this.memoryRoot, "session.jsonl.lina-lease.sqlite"),
			"session-lease",
		);
		writePrivate(
			join(this.memoryRoot, "session.jsonl.lina-lease.sqlite-wal"),
			"session-lease-wal",
		);
		writePrivate(
			join(this.memoryRoot, "session.jsonl.lina-lease.sqlite-shm"),
			"session-lease-shm",
		);
		writePrivate(
			join(this.settingsRoot, "settings.json"),
			'{"model":"grok-4.6","role":"default"}\n',
		);
		writePrivate(
			join(this.settingsRoot, "prompts", "custom.txt"),
			"be brief\n",
		);
		writePrivate(
			join(this.settingsRoot, "installation-lock.sqlite"),
			"lock-main",
		);
		writePrivate(
			join(this.settingsRoot, "installation-lock.sqlite-wal"),
			"lock-wal",
		);
		writePrivate(
			join(this.settingsRoot, "installation-lock.sqlite-shm"),
			"lock-shm",
		);
		writePrivate(
			join(this.settingsRoot, "installation-lock.sqlite-journal"),
			"lock-journal",
		);
		writePrivate(join(this.settingsRoot, ".env"), "SECRET=should-not-copy\n");
		writePrivate(
			join(this.settingsRoot, "credentials.json"),
			'{"token":"nope"}\n',
		);
		writePrivate(join(this.settingsRoot, "auth.json"), '{"apiKey":"nope"}\n');
	}

	close(): void {
		rmSync(this.dir, { recursive: true, force: true });
	}
}

export const COVERAGE_GAPS = [
	"openviking shared memory is external",
	"codex session history is external",
] as const;

function writePrivate(path: string, content: string): void {
	writeFileSync(path, content, { mode: 0o600 });
	chmodSync(path, 0o600);
}
