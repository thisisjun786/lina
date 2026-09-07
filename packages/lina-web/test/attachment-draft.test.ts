import { expect, test } from "bun:test";
import {
	AttachmentDraft,
	attachmentLink,
} from "../../lina-client/src/attachment-draft.ts";

const session = "12345678-1234-4234-8234-123456789012";
const ref = {
	id: "87654321-1234-4234-8234-123456789012",
	name: "메모.txt",
	sessionId: session,
};
test("full draft preserves exact attachment references across submit and recovery", () => {
	const d = new AttachmentDraft();
	d.value = `please read\n\n${attachmentLink(ref)}`;
	expect(d.text).toBe("please read");
	expect(d.refs).toEqual([ref]);
	expect(d.value).toBe(`please read\n\n${attachmentLink(ref)}`);
	d.text = "revised";
	expect(d.value).toBe(`revised\n\n${attachmentLink(ref)}`);
	d.remove(ref.id);
	expect(d.value).toBe("revised");
});
test("ordinary prose, malformed links and foreign refs are never silently discarded", () => {
	const d = new AttachmentDraft();
	const text = "  paragraph\n\n[bad](/api/attachments/../../x)\n";
	d.value = text;
	expect(d.value).toBe(text);
	expect(d.refs).toHaveLength(0);
	d.value = attachmentLink({ ...ref, sessionId: "other" });
	expect(d.refs).toHaveLength(0);
});
test("selection and full message length limits include links", () => {
	const d = new AttachmentDraft();
	d.text = "x".repeat(15900);
	expect(() => d.add(ref)).toThrow();
	d.text = "";
	d.add(ref);
	expect(d.refs).toHaveLength(1);
	d.add(ref);
	expect(d.refs).toHaveLength(1);
});
