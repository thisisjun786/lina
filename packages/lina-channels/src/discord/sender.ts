import type { DiscordRest } from "./rest.ts";

const PARAGRAPH = "\n\n";
type SenderRest = Pick<
	DiscordRest,
	"createMessage" | "deleteOwnReaction" | "addReaction"
>;
type SenderLog = (...args: readonly unknown[]) => void;

type SenderOptions = {
	readonly rest: SenderRest;
	readonly channelId: string;
	readonly log?: SenderLog;
};
type Reply = { readonly replyToMessageId: string; readonly text: string };

export function splitDiscordContent(
	text: string,
	max = 2000,
): readonly string[] {
	const result: string[] = [];
	let remaining = text;
	while (remaining.length > 0) {
		while (remaining.startsWith(PARAGRAPH))
			remaining = remaining.slice(PARAGRAPH.length);
		if (remaining.length === 0) break;
		if (remaining.length <= max) {
			result.push(remaining);
			break;
		}
		const prefix = remaining.slice(0, max);
		const boundary = prefix.lastIndexOf(PARAGRAPH);
		const last = prefix.charCodeAt(prefix.length - 1);
		const cut =
			boundary > 0
				? boundary
				: max - (last >= 0xd800 && last <= 0xdbff ? 1 : 0);
		result.push(remaining.slice(0, cut));
		remaining = remaining.slice(cut + (boundary > 0 ? PARAGRAPH.length : 0));
	}
	return result;
}

async function nonceFor(
	replyToMessageId: string,
	index: number,
	chunk: string,
): Promise<string> {
	const input = new TextEncoder().encode(
		`${replyToMessageId}\n${index}\n${chunk}`,
	);
	const digest = await crypto.subtle.digest("SHA-256", input);
	return [...new Uint8Array(digest)]
		.map((byte) => byte.toString(16).padStart(2, "0"))
		.join("")
		.slice(0, 25);
}

export function createDiscordSender(options: SenderOptions) {
	const log = options.log ?? console.error;
	return {
		sendReply: async ({
			replyToMessageId,
			text,
		}: Reply): Promise<{ readonly messageIds: readonly string[] }> => {
			if (text.trim().length === 0) return { messageIds: [] };
			const messageIds: string[] = [];
			for (const [index, chunk] of splitDiscordContent(text).entries()) {
				if (chunk.trim().length === 0) continue;
				const message = await options.rest.createMessage(options.channelId, {
					content: chunk,
					nonce: await nonceFor(replyToMessageId, index, chunk),
					message_reference: { message_id: replyToMessageId },
				});
				messageIds.push(message.id);
			}
			try {
				await options.rest.deleteOwnReaction(
					options.channelId,
					replyToMessageId,
					"👀",
				);
			} catch (error) {
				log("discord delete reaction failed", error);
			}
			try {
				await options.rest.addReaction(
					options.channelId,
					replyToMessageId,
					"👍",
				);
			} catch (error) {
				log("discord add reaction failed", error);
			}
			return { messageIds };
		},
	};
}
