import type { DialogueRoom } from "../../../lina-core/src/onboarding/dialogue-types.ts";
import {
	emptyUserAnswers,
	parseInterviewMode,
	requireRevision,
	requireUuid,
	unspecifiedProfile,
} from "../../../lina-core/src/onboarding/helpers.ts";
import {
	CHAPTER_IDS,
	type SaveUserInput,
} from "../../../lina-core/src/onboarding/types.ts";
import { storedConversationEmpty } from "./intro-history.ts";
import type { AgentFleet } from "./manager.ts";
export function nativeConversationEmpty(fleet: AgentFleet): boolean {
	const app = fleet.opened("lina");
	if (!app) return storedConversationEmpty(fleet.root);
	return (
		!!app &&
		!app.runtime.native.history().some((raw) => {
			if (!raw || typeof raw !== "object" || !("message" in raw)) return false;
			const m = raw.message;
			return (
				!!m &&
				typeof m === "object" &&
				"role" in m &&
				(m.role === "user" || m.role === "assistant")
			);
		})
	);
}
export function bool(value: unknown): boolean {
	if (typeof value !== "boolean") throw Error("invalid boolean");
	return value;
}
export function startIntro(
	fleet: AgentFleet,
	agentId: string,
	kind: unknown,
	mode: unknown,
	sourceDraftId?: string,
	fresh = false,
	firstEntryOverride?: boolean,
): DialogueRoom {
	if (kind !== "user" && kind !== "persona") throw Error("invalid kind");
	if (kind === "user" && agentId !== "lina")
		throw Error("user introduction belongs to Lina");
	const profile = fleet.agents.get(agentId);
	if (!profile) throw Error("unknown agent");
	const previous = fleet.introductions.latest(agentId);
	if (previous && previous.status !== "done") {
		if (kind === "user" && previous.finalization?.["firstEntry"] !== true)
			throw Error("first introduction completed conflict");
		if (previous.kind !== kind) throw Error("active introduction conflict");
		return previous;
	}
	if (
		kind === "user" &&
		firstEntryOverride !== true &&
		(previous ||
			fleet.onboarding.user().confirmed ||
			!nativeConversationEmpty(fleet))
	)
		throw Error("first introduction completed conflict");
	const draft =
		kind === "persona"
			? fleet.onboarding.createDraft(
					{ targetAgentId: agentId, mode: parseInterviewMode(mode) },
					{
						agents: fleet.agents,
						presets: fleet.presets,
						existingCount: fleet.agents.list().length,
					},
					{ fresh },
				)
			: null;
	const source = sourceDraftId
		? fleet.onboarding.getDraft(sourceDraftId)
		: null;
	if (
		sourceDraftId &&
		(!source ||
			source.targetAgentId !== null ||
			source.appliedRevision !== null)
	)
		throw Error("invalid source draft");
	const { revision: _, ...input } = profile;
	const room = fleet.introductions.create({
		agentId,
		kind,
		mode: parseInterviewMode(mode),
		draftId: draft?.id ?? null,
		data: {
			profile: source ? { ...source.profile, id: agentId } : input,
			chapters: Object.fromEntries(
				CHAPTER_IDS.map((k) => [k, (source ?? draft)?.chapters[k].text ?? ""]),
			) as Record<(typeof CHAPTER_IDS)[number], string>,
			user: kind === "user" ? fleet.onboarding.user().draft : {},
			summary: [],
			ready: false,
		},
	});
	if (kind === "user")
		return fleet.introductions.patch(room.id, room.revision, {
			finalization: {
				firstEntry:
					firstEntryOverride ??
					(!previous &&
						!fleet.onboarding.user().confirmed &&
						nativeConversationEmpty(fleet)),
			},
		});
	return room;
}
export async function birth(
	fleet: AgentFleet,
	birthId: unknown,
	presetId: unknown,
	mode: unknown,
	sourceDraftId?: unknown,
) {
	const receipt = requireUuid(birthId, "birth id"),
		parsedMode = parseInterviewMode(mode);
	if (presetId !== null && typeof presetId !== "string")
		throw Error("invalid preset");
	const preset =
		presetId === null ? null : fleet.presets.find((p) => p.id === presetId);
	if (presetId !== null && !preset) throw Error("unknown preset");
	const id = preset?.id ?? `agent-${receipt.replaceAll("-", "")}`;
	if (preset) {
		if (!fleet.agents.get(id))
			fleet.agents.applyAuthored(preset, null, receipt);
		return { agentId: id, roomId: null, url: `/?agent=${id}` };
	}
	const sourceId =
		sourceDraftId === undefined
			? undefined
			: requireUuid(sourceDraftId, "source draft id");
	if (sourceId) {
		const source = fleet.onboarding.getDraft(sourceId);
		if (
			!source ||
			source.targetAgentId !== null ||
			source.appliedRevision !== null
		)
			throw Error("invalid source draft");
	}
	const agentId = id;
	fleet.agents.applyAuthored(unspecifiedProfile(id), null, receipt);
	const room =
		fleet.introductions.latest(agentId) ??
		startIntro(fleet, agentId, "persona", parsedMode, sourceId);
	return {
		agentId,
		roomId: room.status === "done" ? null : room.id,
		url:
			room.status === "done" ? `/?agent=${agentId}` : `/?onboarding=${room.id}`,
	};
}

/** Later domain templates seed a personal copy; the legacy preset route keeps its identity. */
export function birthFromTemplate(
	fleet: AgentFleet,
	birthId: unknown,
	templateId: unknown,
	mode: unknown,
) {
	const receipt = requireUuid(birthId, "birth id");
	const parsedMode = parseInterviewMode(mode);
	const template = fleet.presets.find(
		(p) => p.id === templateId && p.id !== "lina",
	);
	if (!template) throw Error("unknown domain template");
	const agentId = `agent-${receipt.replaceAll("-", "")}`;
	fleet.agents.applyAuthored({ ...template, id: agentId }, null, receipt);
	const room =
		fleet.introductions.latest(agentId) ??
		startIntro(fleet, agentId, "persona", parsedMode);
	return {
		agentId,
		roomId: room.status === "done" ? null : room.id,
		url:
			room.status === "done" ? `/?agent=${agentId}` : `/?onboarding=${room.id}`,
	};
}
// Freeze the exact CAS input before writes to the user/profile databases. Recovery never
// reapplies over a later user correction. All synchronous mutations occur under the route reservation.
function saveUserOnce(fleet: AgentFleet, input: SaveUserInput) {
	const current = fleet.onboarding.user();
	if (current.revision === input.revision) {
		fleet.onboarding.saveUser(
			input,
			new Set(fleet.agents.list().map((a) => a.id)),
		);
		return;
	}
	const expectedConfirmed = Object.fromEntries(
		Object.entries(input.answers).map(([k, v]) => [k, v.trim()]),
	);
	if (
		current.revision !== input.revision + 1 ||
		JSON.stringify(current.draft) !== JSON.stringify(input.answers) ||
		JSON.stringify(current.sharedAgentIds) !==
			JSON.stringify(input.sharedAgentIds) ||
		(input.confirm &&
			JSON.stringify(current.confirmed?.answers) !==
				JSON.stringify(expectedConfirmed))
	)
		throw Error("stale user revision conflict");
}
export function finishIntro(
	fleet: AgentFleet,
	initialRoom: DialogueRoom,
	input: Record<string, unknown>,
): DialogueRoom {
	let room = initialRoom;
	const skip = bool(input["skip"]),
		share = bool(input["shareUser"]);
	if (room.status === "done" || room.status === "choices") {
		const receipt = room.finalization;
		if (
			receipt?.["action"] !== "finish" ||
			receipt["skip"] !== skip ||
			receipt["shareUser"] !== share
		)
			throw Error("finalization conflict");
		return room;
	}
	if (room.status === "active") {
		if (room.revision !== requireRevision(input["revision"]))
			throw Error("stale room revision");
		const user = fleet.onboarding.user();
		if (user.revision !== requireRevision(input["userRevision"]))
			throw Error("stale user revision");
		const draft = room.draftId ? fleet.onboarding.getDraft(room.draftId) : null;
		const finalization = {
			action: "finish",
			firstEntry: room.finalization?.["firstEntry"] === true,
			skip,
			shareUser: share,
			userRevision: user.revision,
			draftRevision: draft?.revision ?? null,
			userInput: {
				revision: user.revision,
				answers: { ...emptyUserAnswers(), ...room.data.user },
				confirm: true,
				sharedAgentIds: share
					? [...new Set([...user.sharedAgentIds, "lina"])]
					: user.sharedAgentIds.filter((id) => id !== "lina"),
			},
		};
		room = fleet.introductions.patch(room.id, room.revision, {
			status: "applying",
			finalization,
		});
	}
	const f = room.finalization;
	if (
		f?.["action"] !== "finish" ||
		f["skip"] !== skip ||
		f["shareUser"] !== share
	)
		throw Error("finalization conflict");
	if (!skip) {
		if (room.kind === "user")
			saveUserOnce(fleet, f["userInput"] as SaveUserInput);
		else {
			if (!room.draftId) throw Error("missing draft");
			fleet.onboarding.applyDraft(
				room.draftId,
				{
					revision: requireRevision(f["draftRevision"]),
					userRevision: requireRevision(f["userRevision"]),
					shareUser: share,
				},
				fleet.agents,
				{
					candidate: {
						profile: room.data.profile,
						chapters: room.data.chapters,
					},
				},
			);
		}
	}
	return fleet.introductions.patch(room.id, room.revision, {
		status: room.kind === "user" ? "choices" : "done",
	});
}
export async function chooseIntro(
	fleet: AgentFleet,
	initialRoom: DialogueRoom,
	input: Record<string, unknown>,
) {
	let room = initialRoom;
	const birthId = requireUuid(input["birthId"], "birth id"),
		share = bool(input["shareUser"]);
	const presetId = input["presetId"];
	if (
		presetId !== null &&
		(typeof presetId !== "string" ||
			!fleet.presets.some((p) => p.id === presetId))
	)
		throw Error("invalid preset");
	if (room.kind !== "user") throw Error("invalid selection room");
	if (room.status === "done") {
		const result = room.finalization;
		if (
			result?.["action"] !== "choose" ||
			result["birthId"] !== birthId ||
			result["presetId"] !== presetId ||
			result["shareUser"] !== share
		)
			throw Error("selection conflict");
		const agentId =
			typeof presetId === "string"
				? presetId
				: `agent-${birthId.replaceAll("-", "")}`;
		const selected =
			presetId === null ? fleet.introductions.latest(agentId) : null;
		return {
			agentId,
			roomId: selected && selected.status !== "done" ? selected.id : null,
			url:
				selected && selected.status !== "done"
					? `/?onboarding=${selected.id}`
					: `/?agent=${agentId}`,
		};
	}
	if (room.status === "choices") {
		if (
			room.revision !== requireRevision(input["revision"]) ||
			fleet.onboarding.user().revision !==
				requireRevision(input["userRevision"])
		)
			throw Error("stale selection revision");
		room = fleet.introductions.patch(room.id, room.revision, {
			status: "applying",
			finalization: {
				action: "choose",
				firstEntry: room.finalization?.["firstEntry"] === true,
				birthId,
				presetId,
				shareUser: share,
				userRevision: input["userRevision"],
			},
		});
	}
	const f = room.finalization;
	if (
		f?.["action"] !== "choose" ||
		f["birthId"] !== birthId ||
		f["presetId"] !== presetId ||
		f["shareUser"] !== share
	)
		throw Error("selection conflict");
	const result = await birth(fleet, birthId, presetId, room.mode);
	const user = fleet.onboarding.user();
	const expected = requireRevision(f["userRevision"]);
	// Sharing is an explicit selection action. No user description is copied into persona fields.
	const shared = share
		? [...new Set([...user.sharedAgentIds, result.agentId])]
		: user.sharedAgentIds.filter((id) => id !== result.agentId);
	if (JSON.stringify(shared) !== JSON.stringify(user.sharedAgentIds)) {
		if (user.revision !== expected) throw Error("stale user revision");
		saveUserOnce(fleet, {
			revision: expected,
			answers: user.draft,
			confirm: false,
			sharedAgentIds: shared,
		});
	} else if (user.revision !== expected && user.revision !== expected + 1)
		throw Error("stale user revision");
	fleet.introductions.patch(room.id, room.revision, { status: "done" });
	return result;
}
