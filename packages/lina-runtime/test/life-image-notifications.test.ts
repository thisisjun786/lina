import { expect, test } from "bun:test";
import { FleetLifeAgents } from "../src/fleet/life-runtime-state.ts";

test("visual commits wake LIFE; reads, pin replay and no-op visual edits do not", () => {
	let wakes = 0;
	const agents = new FleetLifeAgents(":memory:", () => {
		wakes++;
	});
	try {
		agents.create({
			id: "lina",
			name: "Lina",
			role: "assistant",
			personality: "curious",
			voice: "warm",
			profile: "Private profile",
			appearance: "Silver hair",
			interests: [],
			avatarId: null,
			evolution: "adaptive",
		});
		wakes = 0;
		const input = {
			anchors: ["silver hair"],
			textIdentity: "approved",
			canonicalReferenceId: null,
			avatarPolicy: null,
			referenceLimits: null,
			maxHistoryRecords: 10,
		};
		const visual = agents.updateVisual("lina", 1, input);
		expect(wakes).toBe(1);
		agents.visual("lina");
		agents.updateVisual("lina", visual.revision, input);
		expect(wakes).toBe(1);
		const pin = {
			requestKey: "pin-once",
			expectedRevision: visual.revision,
			pinned: true,
		};
		agents.setAvatarPinned("lina", pin);
		expect(wakes).toBe(2);
		agents.setAvatarPinned("lina", pin);
		expect(wakes).toBe(2);
	} finally {
		agents.close();
	}
});
