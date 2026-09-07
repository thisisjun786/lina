import { appendFile, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { type Static, Type } from "typebox";

const appendParams = Type.Object({
	text: Type.String({ minLength: 1, description: "One line to remember" }),
});
type AppendParams = Static<typeof appendParams>;

export function createNotepadTools(dataDir: string) {
	const file = join(dataDir, "notepad.md");
	const read = {
		name: "lina_notepad_read",
		label: "Notepad read",
		description:
			"Read Lina's working notepad (hypotheses, decisions, loose ends).",
		parameters: Type.Object({}),
		async execute() {
			let text: string;
			try {
				text = await readFile(file, "utf8");
			} catch (error) {
				if (
					error instanceof Error &&
					"code" in error &&
					error.code === "ENOENT"
				)
					text = "(empty)";
				else throw error;
			}
			return { content: [{ type: "text" as const, text }], details: { file } };
		},
	};
	const append = {
		name: "lina_notepad_append",
		label: "Notepad append",
		description: "Append one timestamped line to Lina's working notepad.",
		parameters: appendParams,
		async execute(_id: string, params: AppendParams) {
			await mkdir(dataDir, { recursive: true });
			const line = `- [${new Date().toISOString()}] ${params.text}\n`;
			await appendFile(file, line, "utf8");
			return {
				content: [{ type: "text" as const, text: `appended: ${params.text}` }],
				details: { file },
			};
		},
	};
	return { read, append };
}
