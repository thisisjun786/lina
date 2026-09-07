import { Type } from "typebox";

export type LinaStatus = {
	readonly startedAt: string;
	readonly interventionPort: number;
	readonly lastAgentEndAt: string | undefined;
};

export function createStatusTool(status: () => LinaStatus) {
	return {
		name: "lina_status",
		label: "Lina status",
		description:
			"Report Lina's runtime status and, in the app, the current working-state revision, goal and active summary. Use this before replacing working state.",
		parameters: Type.Object({}),
		async execute() {
			const snapshot = status();
			return {
				content: [
					{ type: "text" as const, text: JSON.stringify(snapshot, null, 2) },
				],
				details: snapshot,
			};
		},
	};
}
