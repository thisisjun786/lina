import { type Static, Type } from "typebox";
import type { ContextStore } from "../../../lina-core/src/context/store.ts";

const appendParams = Type.Object(
	{
		text: Type.String({
			minLength: 1,
			maxLength: 8192,
			description: "One note to remember",
		}),
	},
	{ additionalProperties: false },
);

/** Managed notes only. The old plaintext file remains available to its human owner. */
export function createNotepadTools(
	store: ContextStore,
	activeRequestId: () => string | undefined,
) {
	return {
		read: {
			name: "lina_notepad_read",
			label: "Notepad read",
			description: "Read eligible finalized notes from Lina's working notepad.",
			parameters: Type.Object({}, { additionalProperties: false }),
			async execute() {
				const { value: notes, beforeDeliver } = store.readNotes();
				const text =
					notes
						.map((note) => `- [${note.createdAt}] ${note.text}`)
						.join("\n")
						.slice(0, 16384) || "(empty)";
				return {
					content: [{ type: "text" as const, text }],
					details: {},
					beforeDeliver,
				};
			},
		},
		append: {
			name: "lina_notepad_append",
			label: "Notepad append",
			description:
				"Save a working note pending this request's ordinary completion.",
			parameters: appendParams,
			async execute(id: string, params: Static<typeof appendParams>) {
				const requestId = activeRequestId();
				const receipt = store.appendNote(
					id,
					params.text,
					requestId ? { activeRequestId: requestId } : {},
				);
				return {
					content: [{ type: "text" as const, text: `Note ${receipt.status}.` }],
					details: receipt,
				};
			},
		},
	};
}
