import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryFs, ReadOnlyMemoryError } from "../src/memory-fs.ts";
import { parseMemoryFile } from "../src/types.ts";

describe("MemoryFs", () => {
	let dir: string;

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), "lina-memory-fs-"));
	});

	afterEach(async () => {
		await rm(dir, { recursive: true, force: true });
	});

	it("round-trips description and body when a memory file is written then read", async () => {
		const fs = new MemoryFs(dir);
		await fs.write("notes.md", {
			description: "daily notes",
			body: "planted basil",
		});
		const block = await fs.read("notes.md");
		expect(String(block.path)).toBe("notes.md");
		expect(block.description).toBe("daily notes");
		expect(block.body).toBe("planted basil");
		expect(block.readOnly).toBe(false);
	});

	it("throws ReadOnlyMemoryError when writing to a read_only block", async () => {
		await Bun.write(
			join(dir, "locked.md"),
			"---\ndescription: locked persona\nread_only: true\n---\ndo not edit\n",
		);
		const fs = new MemoryFs(dir);
		let thrown: unknown;
		try {
			await fs.write("locked.md", { description: "hijack", body: "mutated" });
		} catch (error) {
			thrown = error;
		}
		expect(thrown).toBeInstanceOf(ReadOnlyMemoryError);
	});

	it("yields kind error when frontmatter is malformed", () => {
		const result = parseMemoryFile("this is not a memory file");
		expect(result.kind).toBe("error");
		if (result.kind !== "error") {
			throw new Error("expected parse failure");
		}
		expect(result.error.name).toBe("MemoryParseError");
	});

	it("creates a git commit when commit is called after a write", async () => {
		const fs = new MemoryFs(dir);
		await fs.write("log.md", { description: "log", body: "day one" });
		await fs.commit("record day one");
		const count = await gitOnelineCount(dir);
		expect(count).toBe(1);
	});
});

async function gitOnelineCount(cwd: string): Promise<number> {
	const process = Bun.spawn(
		[
			"git",
			"-c",
			"user.name=lina-memory",
			"-c",
			"user.email=lina-memory@local",
			"log",
			"--oneline",
		],
		{ cwd, stdout: "pipe", stderr: "pipe" },
	);
	const exitCode = await process.exited;
	const stdout = await new Response(process.stdout).text();
	const stderr = await new Response(process.stderr).text();
	if (exitCode !== 0) {
		throw new Error(stderr);
	}
	const trimmed = stdout.trim();
	if (trimmed.length === 0) {
		return 0;
	}
	return trimmed.split("\n").length;
}
