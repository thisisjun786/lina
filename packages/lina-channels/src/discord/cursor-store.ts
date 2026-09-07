import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";
import { SnowflakeSchema } from "./schemas.ts";

const CursorSchema = z.object({
	version: z.literal(1),
	channelId: SnowflakeSchema,
	lastSeenMessageId: z.union([z.literal("0"), SnowflakeSchema]),
});

export type DiscordCursor = z.infer<typeof CursorSchema>;

export class CursorCorruptError extends Error {
	override readonly name = "CursorCorruptError";
	readonly path: string;

	constructor(path: string, cause: unknown) {
		super(`corrupt Discord cursor: ${path}`, { cause });
		this.path = path;
	}
}

export class CursorStore {
	readonly path: string;
	readonly channelId: string;

	constructor(path: string, channelId: string) {
		if (!SnowflakeSchema.safeParse(channelId).success) {
			throw new TypeError("channelId must be a Discord snowflake");
		}
		this.path = path;
		this.channelId = channelId;
	}

	async read(): Promise<DiscordCursor | undefined> {
		let raw: string;
		try {
			raw = await readFile(this.path, "utf8");
		} catch (error) {
			if (
				error instanceof Error &&
				"code" in error &&
				error.code === "ENOENT"
			) {
				return undefined;
			}
			throw error;
		}
		try {
			const cursor = CursorSchema.parse(JSON.parse(raw));
			if (cursor.channelId !== this.channelId) {
				throw new Error("cursor channel does not match configured channel");
			}
			return cursor;
		} catch (error) {
			throw new CursorCorruptError(this.path, error);
		}
	}

	async write(cursor: DiscordCursor): Promise<void> {
		const validated = CursorSchema.parse(cursor);
		if (validated.channelId !== this.channelId) {
			throw new CursorCorruptError(
				this.path,
				new Error("cursor channel does not match configured channel"),
			);
		}
		const temporaryPath = `${this.path}.tmp`;
		await mkdir(dirname(this.path), { recursive: true });
		try {
			const handle = await open(temporaryPath, "w");
			try {
				await handle.writeFile(JSON.stringify(validated));
				await handle.sync();
			} finally {
				await handle.close();
			}
			await rename(temporaryPath, this.path);
			const parent = await open(dirname(this.path), "r");
			try {
				await parent.sync();
			} finally {
				await parent.close();
			}
		} finally {
			await rm(temporaryPath, { force: true });
		}
	}

	async advance(id: string): Promise<boolean> {
		const current = await this.read();
		if (
			current !== undefined &&
			BigInt(id) <= BigInt(current.lastSeenMessageId)
		) {
			return false;
		}
		const next: DiscordCursor = {
			version: 1,
			channelId: this.channelId,
			lastSeenMessageId: id,
		};
		await this.write(next);
		return true;
	}
}
