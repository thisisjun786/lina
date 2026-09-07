import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import {
	type MemoryBlock,
	type MemoryPath,
	MemoryPathSchema,
	parseMemoryFile,
} from "./types.ts";

export class ReadOnlyMemoryError extends Error {
	override readonly name = "ReadOnlyMemoryError";
	readonly path: MemoryPath;

	constructor(path: MemoryPath) {
		super(`cannot write read-only memory block: ${path}`);
		this.path = path;
	}
}

export class MemoryFs {
	readonly root: string;

	constructor(root: string) {
		this.root = root;
	}

	async read(path: string): Promise<MemoryBlock> {
		const memoryPath = MemoryPathSchema.parse(path);
		const raw = await Bun.file(this.resolve(memoryPath)).text();
		const parsed = parseMemoryFile(raw);
		if (parsed.kind === "error") {
			throw parsed.error;
		}
		return {
			path: memoryPath,
			description: parsed.block.description,
			body: parsed.block.body,
			readOnly: parsed.block.readOnly,
		};
	}

	async write(
		path: string,
		payload: { description: string; body: string },
	): Promise<void> {
		const memoryPath = MemoryPathSchema.parse(path);
		const absolute = this.resolve(memoryPath);
		const file = Bun.file(absolute);
		if (await file.exists()) {
			const existing = parseMemoryFile(await file.text());
			if (existing.kind === "ok" && existing.block.readOnly) {
				throw new ReadOnlyMemoryError(memoryPath);
			}
		}
		await mkdir(dirname(absolute), { recursive: true });
		const description = payload.description.replace(/\r?\n/g, " ").trim();
		await Bun.write(
			absolute,
			`---\ndescription: ${description}\n---\n${payload.body}`,
		);
	}

	async list(): Promise<readonly MemoryPath[]> {
		const glob = new Bun.Glob("**/*.md");
		const paths: MemoryPath[] = [];
		for await (const match of glob.scan({ cwd: this.root, onlyFiles: true })) {
			paths.push(MemoryPathSchema.parse(match));
		}
		paths.sort();
		return paths;
	}

	async commit(message: string): Promise<void> {
		await mkdir(this.root, { recursive: true });
		if (!existsSync(join(this.root, ".git"))) {
			await this.git(["init"]);
		}
		await this.git(["add", "-A"]);
		await this.git(["commit", "-m", message]);
	}

	private resolve(path: MemoryPath): string {
		const root = resolve(this.root);
		const absolute = resolve(this.root, path);
		if (absolute !== root && !absolute.startsWith(`${root}${sep}`)) {
			throw new Error(`memory path escapes root: ${path}`);
		}
		return absolute;
	}

	private async git(args: readonly string[]): Promise<void> {
		const process = Bun.spawn(
			[
				"git",
				"-c",
				"user.name=lina-memory",
				"-c",
				"user.email=lina-memory@local",
				...args,
			],
			{ cwd: this.root, stdout: "pipe", stderr: "pipe" },
		);
		const stderr = await new Response(process.stderr).text();
		const exitCode = await process.exited;
		if (exitCode !== 0) {
			throw new Error(
				`git ${args.join(" ")} failed (${String(exitCode)}): ${stderr}`,
			);
		}
	}
}
