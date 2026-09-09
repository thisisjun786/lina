import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type {
	EpisodeTrace,
	ModelTransport,
	PublicCase,
	RunMode,
	StageTrigger,
} from "./harness-types.ts";
import { createSession } from "./modes.ts";
import { decodePublicCase } from "./public-case.ts";
export async function runEpisode(
	value: PublicCase,
	mode: RunMode,
	transport: ModelTransport,
	root?: string,
	decisionId?: () => string,
): Promise<EpisodeTrace> {
	const input = decodePublicCase(value);
	if (root) mkdirSync(root, { recursive: true });
	const session = createSession(mode, input, transport, root, decisionId);
	try {
		let index = 0;
		session.applyStage(index);
		while (session.trace.requests.length < 6) {
			const before = session.trace.requests.length;
			const result = await session.step();
			const stage = input.stages[index];
			if (!stage) throw Error("missing stage");
			const request = session.trace.requests.at(-1);
			if (session.trace.requests.length === before) {
				session.trace.detail = "no model progress";
				break;
			}
			if (request?.transport.kind === "transport-failure") {
				session.trace.detail = "transport failure";
				break;
			}
			const effect = session.trace.effects.find(
				(e) =>
					e.effectId === `${result.decisionId}:tool` &&
					e.receipt.status === "unknown",
			);
			const trigger: StageTrigger | null =
				result.status === "unknown" && effect
					? "owner-unknown"
					: ["answered", "adopted", "deferred", "noop"].includes(result.status)
						? (result.status as StageTrigger)
						: null;
			if (trigger === stage.advanceOn) {
				session.trace.stages.push({
					stage: index,
					purpose: stage.purpose,
					trigger,
					...(effect ? { effectId: effect.effectId } : {}),
				});
				if (index === input.stages.length - 1) {
					session.trace.status = "complete";
					break;
				}
				session.applyStage(++index);
			} else if (trigger && trigger !== "adopted") {
				session.trace.detail = "stage prerequisite not satisfied";
				break;
			} else if (result.status === "unknown") {
				session.trace.detail = "unresolved operation";
				break;
			}
		}
		if (
			session.trace.status !== "complete" &&
			session.trace.requests.length >= 6
		)
			session.trace.status = "limit";
	} catch (error) {
		session.trace.status = "incomplete";
		session.trace.detail =
			error instanceof Error ? error.message : "run failed";
	} finally {
		session.close();
	}
	if (root)
		writeFileSync(
			join(root, "trace.json"),
			`${JSON.stringify(session.trace, null, 2)}\n`,
		);
	return session.trace;
}
