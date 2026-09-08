import { lifeDigest } from "../src/world/life-json.ts";
import { parseLifeInput } from "../src/world/life-validation.ts";
export function workInput(
	worldId: string,
	policyRevision = 1,
	restrict = false,
) {
	const source = {
		kind: "work",
		deliveryId: `delivery-${policyRevision}`,
		operation: restrict ? "restrict" : "upsert",
		sourceDigest: lifeDigest({ policyRevision }),
		policyRevision,
		receipt: {
			receiptId: "receipt",
			receiptRevision: 1,
			supersedesRevision: null,
			taskId: "task",
			turnId: "turn",
			taskRevision: 2,
			ownerAgentId: "lina",
			participantAgentIds: ["lina"],
			attributionStatus: "known",
			outcome: "turn_ended",
			correction: null,
			evidenceDigest: lifeDigest([]),
		},
		fields: restrict
			? null
			: {
					categoryId: "research",
					outcome: "turn_ended",
					participantAgentIds: ["lina"],
					summary: "Finished research",
				},
	};
	const input = parseLifeInput({
		version: 2,
		worldId,
		id: source.deliveryId,
		sourceRevision: 1,
		source,
		payloadDigest: lifeDigest(source),
		consumedLifeRevision: null,
	});
	if (input.version !== 2) throw Error("Missing typed work input");
	return input;
}
