import { z } from "zod";

export const MemoryPathSchema = z.string().min(1).brand<"MemoryPath">();
export type MemoryPath = z.infer<typeof MemoryPathSchema>;

export type MemoryBlock = {
	readonly path: MemoryPath;
	readonly description: string;
	readonly body: string;
	readonly readOnly: boolean;
};

export const Frontmatter = z.object({
	description: z.string().min(1),
	read_only: z.literal("true").optional(),
});

export class MemoryParseError extends Error {
	override readonly name = "MemoryParseError";
}

export type MemoryParseResult =
	| {
			readonly kind: "ok";
			readonly block: Omit<MemoryBlock, "path">;
	  }
	| {
			readonly kind: "error";
			readonly error: MemoryParseError;
	  };

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

export function parseMemoryFile(raw: string): MemoryParseResult {
	const match = FRONTMATTER_RE.exec(raw);
	const frontmatterText = match?.[1];
	const body = match?.[2];
	if (match === null || frontmatterText === undefined || body === undefined) {
		return {
			kind: "error",
			error: new MemoryParseError("missing frontmatter fences"),
		};
	}

	const fields = parseKeyValues(frontmatterText);
	if (fields.description === undefined) {
		return {
			kind: "error",
			error: new MemoryParseError("missing description"),
		};
	}

	const candidate =
		fields.read_only === undefined
			? { description: fields.description }
			: { description: fields.description, read_only: fields.read_only };
	const parsed = Frontmatter.safeParse(candidate);
	if (!parsed.success) {
		return {
			kind: "error",
			error: new MemoryParseError("invalid frontmatter"),
		};
	}

	return {
		kind: "ok",
		block: {
			description: parsed.data.description,
			body,
			readOnly: parsed.data.read_only === "true",
		},
	};
}

function parseKeyValues(frontmatterText: string): {
	description?: string;
	read_only?: string;
} {
	const fields: { description?: string; read_only?: string } = {};
	for (const line of frontmatterText.split(/\r?\n/)) {
		if (line.trim().length === 0) {
			continue;
		}
		const idx = line.indexOf(":");
		if (idx <= 0) {
			continue;
		}
		const key = line.slice(0, idx).trim();
		const value = line.slice(idx + 1).trim();
		if (key === "description") {
			fields.description = value;
		} else if (key === "read_only") {
			fields.read_only = value;
		}
	}
	return fields;
}
