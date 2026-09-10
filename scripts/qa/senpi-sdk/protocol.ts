import { z } from "zod";

export const commandSchema = z.discriminatedUnion("kind", [
	z.object({ kind: z.literal("prompt"), text: z.string() }),
	z.object({ kind: z.literal("correct"), policy: z.string() }),
	z.object({ kind: z.literal("abort") }),
	z.object({ kind: z.literal("crash") }),
	z.object({ kind: z.literal("close") }),
]);
export type Command = z.infer<typeof commandSchema>;
export const packetSchema = z.object({
	kind: z.enum(["ready", "done", "aborted", "effect", "event", "error"]),
	data: z.unknown(),
});
export const messageSchema = z.looseObject({
	role: z.string(),
	content: z.unknown(),
	stopReason: z.string().optional(),
});
export const snapshotSchema = z.object({
	pid: z.number().int().positive(),
	file: z.string(),
	streaming: z.boolean(),
	messages: z.array(messageSchema),
	events: z.array(z.string()),
});
export const wireSchema = z.looseObject({
	model: z.literal("fixture-model"),
	messages: z.array(messageSchema),
	tools: z
		.array(
			z.object({
				type: z.literal("function"),
				function: z.object({ name: z.literal("fixture_effect") }),
			}),
		)
		.length(1),
});
export type Wire = z.infer<typeof wireSchema>;

export async function bounded<T>(
	promise: Promise<T>,
	label: string,
): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			promise,
			new Promise<never>((_, reject) => {
				timer = setTimeout(
					() => reject(new Error(`Deadline: ${label}`)),
					15_000,
				);
			}),
		]);
	} finally {
		clearTimeout(timer);
	}
}
