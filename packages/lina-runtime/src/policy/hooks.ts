import { Type } from "typebox";
import type { LinaHost } from "../host.ts";
import { RESPONSE_MODES, type ResponsePolicy } from "./response.ts";

export function installResponsePolicy(
	host: LinaHost,
	policy: ResponsePolicy,
): void {
	host.on("before_agent_start", () => {
		policy.reset();
	});
	host.registerTool({
		name: "lina_select_response",
		label: "응답 방식 선택",
		description:
			"Select clarification, source research, or authorized execution guidance based on the actual conversation. Does not run work or grant permissions. Ordinary dialogue uses conversation by default. Keep the same persona and existing user scope.",
		parameters: Type.Object({
			mode: Type.Union(RESPONSE_MODES.map((mode) => Type.Literal(mode))),
		}),
		async execute(_id, { mode }, signal) {
			signal?.throwIfAborted();
			const result = policy.select(mode);
			return {
				content: [{ type: "text" as const, text: result.instructions }],
				details: { mode: result.mode },
			};
		},
	});
}
