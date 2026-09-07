type ClipboardData = Pick<DataTransfer, "items" | "files" | "getData">;

/** Snapshot one collection per event; Chromium wrappers may differ in lastModified. */
export function clipboardFiles(data: ClipboardData): File[] {
	const items = Array.from(data.items).flatMap((item) => {
		if (item.kind !== "file") return [];
		const file = item.getAsFile();
		return file ? [file] : [];
	});
	return items.length ? items : Array.from(data.files);
}

export function installClipboardAttachments(
	input: HTMLTextAreaElement,
	addFiles: (files: File[]) => void,
): () => void {
	const paste = (event: ClipboardEvent) => {
		if (event.defaultPrevented || !event.clipboardData) return;
		const files = clipboardFiles(event.clipboardData);
		if (!files.length) return;
		const text = event.clipboardData.getData("text/plain");
		event.preventDefault();
		if (text) {
			input.setRangeText(text, input.selectionStart, input.selectionEnd, "end");
			input.dispatchEvent(new Event("input", { bubbles: true }));
		}
		addFiles(files);
	};
	input.addEventListener("paste", paste);
	return () => input.removeEventListener("paste", paste);
}
