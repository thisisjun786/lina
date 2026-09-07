import { appendFile, readFile } from "node:fs/promises";
import {
	type MessageId,
	type RegistryEntry,
	RegistryEntrySchema,
	type SessionId,
} from "./types.ts";

export class RegistryLineError extends Error {
	readonly lineNumber: number;
	readonly line: string;

	constructor(lineNumber: number, line: string, cause?: unknown) {
		super(`malformed registry line ${lineNumber}`);
		this.name = "RegistryLineError";
		this.lineNumber = lineNumber;
		this.line = line;
		if (cause !== undefined) {
			this.cause = cause;
		}
	}
}

export class SessionRegistry {
	private lineErrors: RegistryLineError[] = [];

	constructor(private readonly filePath: string) {}

	async record(entry: RegistryEntry): Promise<void> {
		await appendFile(this.filePath, `${JSON.stringify(entry)}\n`, "utf8");
	}

	async lookupBySession(
		sessionId: SessionId,
	): Promise<readonly RegistryEntry[]> {
		const entries = await this.load();
		return entries.filter((entry) => entry.sessionId === sessionId);
	}

	async lookupByMessage(
		messageId: MessageId,
	): Promise<RegistryEntry | undefined> {
		const entries = await this.load();
		return entries.find((entry) => entry.messageId === messageId);
	}

	errors(): readonly RegistryLineError[] {
		return this.lineErrors;
	}

	private async load(): Promise<readonly RegistryEntry[]> {
		this.lineErrors = [];
		const content = await this.readFileContents();
		if (content === undefined) {
			return [];
		}
		const entries: RegistryEntry[] = [];
		const lines = content.split("\n");
		for (let index = 0; index < lines.length; index += 1) {
			const line = lines[index];
			if (line === undefined) {
				continue;
			}
			const trimmed = line.trim();
			if (trimmed.length === 0) {
				continue;
			}
			const parsed = this.parseLine(index + 1, trimmed);
			if (parsed !== undefined) {
				entries.push(parsed);
			}
		}
		return entries;
	}

	private async readFileContents(): Promise<string | undefined> {
		try {
			return await readFile(this.filePath, "utf8");
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
	}

	private parseLine(
		lineNumber: number,
		line: string,
	): RegistryEntry | undefined {
		let raw: unknown;
		try {
			raw = JSON.parse(line);
		} catch (error) {
			if (error instanceof SyntaxError) {
				this.lineErrors.push(new RegistryLineError(lineNumber, line, error));
				return undefined;
			}
			throw error;
		}
		const result = RegistryEntrySchema.safeParse(raw);
		if (!result.success) {
			this.lineErrors.push(
				new RegistryLineError(lineNumber, line, result.error),
			);
			return undefined;
		}
		return result.data;
	}
}
