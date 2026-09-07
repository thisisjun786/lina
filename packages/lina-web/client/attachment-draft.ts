export type DraftAttachment = { id: string; name: string; sessionId: string };
const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const LINE = new RegExp(
	`^\\[([^\\[\\]<>\\x00-\\x1f\\\\/]{1,120})\\]\\(/api/attachments/(${UUID})\\?sessionId=(${UUID})\\)$`,
	"i",
);
export function attachmentLink(ref: DraftAttachment): string {
	return `[${ref.name}](/api/attachments/${ref.id}?sessionId=${ref.sessionId})`;
}
export function attachmentHref(ref: DraftAttachment, suffix = ""): string {
	return `/api/attachments/${ref.id}${suffix}?sessionId=${encodeURIComponent(ref.sessionId)}`;
}
export class AttachmentDraft {
	text = "";
	private items: DraftAttachment[] = [];
	private original:
		| { text: string; signature: string; value: string }
		| undefined;
	get refs(): readonly DraftAttachment[] {
		return this.items;
	}
	get value(): string {
		const signature = JSON.stringify(this.items);
		if (
			this.original?.text === this.text &&
			this.original.signature === signature
		)
			return this.original.value;
		return this.items.length
			? [this.text, ...this.items.map(attachmentLink)]
					.filter(Boolean)
					.join("\n\n")
			: this.text;
	}
	set value(value: string) {
		const lines = value.split("\n");
		const refs: DraftAttachment[] = [];
		while (lines.length) {
			const match = LINE.exec(lines.at(-1) ?? "");
			if (!match?.[1] || !match[2] || !match[3]) break;
			refs.unshift({ name: match[1], id: match[2], sessionId: match[3] });
			lines.pop();
			if (lines.at(-1) === "") lines.pop();
		}
		if (refs.length > 4) {
			this.text = value;
			this.items = [];
		} else {
			this.text = refs.length ? lines.join("\n") : value;
			this.items = refs;
		}
		this.original = {
			text: this.text,
			signature: JSON.stringify(this.items),
			value,
		};
	}
	add(ref: DraftAttachment): void {
		if (
			this.items.some(
				(item) => item.id === ref.id && item.sessionId === ref.sessionId,
			)
		)
			return;
		if (!LINE.test(attachmentLink(ref)))
			throw new Error("유효하지 않은 첨부파일");
		if (this.items.length >= 4) throw new Error("첨부 한도 초과 · 최대 4개");
		const previous = this.items;
		this.items = [...previous, ref];
		if (this.value.length > 16000) {
			this.items = previous;
			throw new Error("첨부 공간 부족 · 메시지 길이 줄이기");
		}
	}
	remove(id: string): void {
		this.items = this.items.filter((ref) => ref.id !== id);
	}
}
