import type { AgentInput } from "../../lina-core/src/agents/types.ts";
import {
	BIRTH_STORAGE_KEY,
	type BootDecision,
	type BootQuery,
	type ChooseResult,
	FAST_TURN_TARGET,
	INTRO_DRAFT_PREFIX,
	INTRO_REQUEST_PREFIX,
	INTRO_TURN_LIMIT,
	type InterviewMode,
	type IntroBubble,
	type IntroChapters,
	type IntroData,
	type IntroEntry,
	type IntroKind,
	type IntroRoom,
	type IntroSnapshot,
	type IntroStatus,
	type IntroTurn,
	type LegacyDraftRef,
	type MemoryStore,
	PERSONA_THOUGHTFUL_TARGET,
	USER_THOUGHTFUL_TARGET,
	UUID_RE,
} from "./intro-types.ts";
import { UNSPECIFIED } from "./onboarding-types.ts";

export function isIntroUuid(value: string): boolean {
	return UUID_RE.test(value);
}

export function parseBootQuery(href: string): BootQuery {
	const url = new URL(href, "http://lina.local");
	const agent = url.searchParams.get("agent");
	const onboarding = url.searchParams.get("onboarding");
	const previous = url.searchParams.get("previous");
	return {
		agentId: agent && /^[a-z][a-z0-9-]{0,47}$/.test(agent) ? agent : null,
		onboarding:
			onboarding === "user" || (onboarding !== null && isIntroUuid(onboarding))
				? onboarding
				: null,
		previous: previous !== null && isIntroUuid(previous) ? previous : null,
	};
}

export function decideBoot(
	query: BootQuery,
	entry?: IntroEntry | null,
): BootDecision {
	if (query.agentId) return { kind: "normal", agentId: query.agentId };
	if (query.onboarding === "user") {
		if (!entry) return { kind: "entry" };
		if (entry.resume)
			return { kind: "intro", intent: "room", roomId: entry.resume.id };
		return entry.firstUser
			? { kind: "intro", intent: "user" }
			: { kind: "normal", agentId: "lina" };
	}
	if (query.onboarding)
		return { kind: "intro", intent: "room", roomId: query.onboarding };
	if (!entry) return { kind: "entry" };
	if (entry.resume)
		return {
			kind: "intro",
			intent: "room",
			roomId: entry.resume.id,
			agentId: entry.resume.agentId,
		};
	if (entry.firstUser) return { kind: "intro", intent: "user" };
	return { kind: "normal", agentId: "lina" };
}

export function ordinaryAgentUrl(id: string): string {
	return "/?agent=" + encodeURIComponent(id);
}

export function introUserUrl(): string {
	return "/?onboarding=user";
}

export function introRoomUrl(id: string, previous?: string | null): string {
	const base = "/?onboarding=" + encodeURIComponent(id);
	if (previous && isIntroUuid(previous))
		return base + "&previous=" + encodeURIComponent(previous);
	return base;
}

export function introDraftKey(roomId: string): string {
	return INTRO_DRAFT_PREFIX + roomId;
}

export function introRequestKey(roomId: string): string {
	return INTRO_REQUEST_PREFIX + roomId;
}

export function turnTarget(kind: IntroKind, mode: InterviewMode): number {
	if (mode === "fast") return FAST_TURN_TARGET;
	return kind === "user" ? USER_THOUGHTFUL_TARGET : PERSONA_THOUGHTFUL_TARGET;
}

export function answeredTurnCount(turns: IntroTurn[]): number {
	return turns.filter((turn) => turn.text !== null).length;
}

export function persistBirthId(
	storage: MemoryStore | undefined,
	uuid: () => string,
): string {
	try {
		const existing = storage?.getItem(BIRTH_STORAGE_KEY) ?? "";
		if (isIntroUuid(existing)) return existing;
		const id = uuid();
		storage?.setItem(BIRTH_STORAGE_KEY, id);
		return id;
	} catch {
		return uuid();
	}
}

export function clearBirthId(storage: MemoryStore | undefined): void {
	try {
		storage?.removeItem?.(BIRTH_STORAGE_KEY);
	} catch {
		/* This attempt can still retry from memory. */
	}
}

export function readIntroDraft(
	storage: MemoryStore | undefined,
	roomId: string,
): string {
	try {
		return (storage?.getItem(introDraftKey(roomId)) ?? "").slice(
			0,
			INTRO_TURN_LIMIT,
		);
	} catch {
		return "";
	}
}

export function saveIntroDraft(
	storage: MemoryStore | undefined,
	roomId: string,
	text: string,
): void {
	try {
		storage?.setItem(introDraftKey(roomId), text.slice(0, INTRO_TURN_LIMIT));
	} catch {
		/* Composer text remains in the page. */
	}
}

export function readIntroRequest(
	storage: MemoryStore | undefined,
	roomId: string,
): { requestId: string; text: string | null } | null {
	try {
		const raw = storage?.getItem(introRequestKey(roomId));
		if (!raw) return null;
		const value: unknown = JSON.parse(raw);
		if (!value || typeof value !== "object" || Array.isArray(value))
			return null;
		const row = value as Record<string, unknown>;
		const requestId = row["requestId"];
		const textValue = row["text"];
		if (typeof requestId !== "string" || !isIntroUuid(requestId)) return null;
		if (textValue !== null && typeof textValue !== "string") return null;
		return { requestId, text: textValue };
	} catch {
		return null;
	}
}

export function saveIntroRequest(
	storage: MemoryStore | undefined,
	roomId: string,
	request: { requestId: string; text: string | null },
): void {
	try {
		storage?.setItem(introRequestKey(roomId), JSON.stringify(request));
	} catch {
		/* Retry can still use in-memory requestId. */
	}
}

export function clearIntroRequest(
	storage: MemoryStore | undefined,
	roomId: string,
): void {
	try {
		storage?.removeItem?.(introRequestKey(roomId));
	} catch {
		/* */
	}
}

export function boundIntroText(text: string): string {
	return text.slice(0, INTRO_TURN_LIMIT);
}

export function displayName(name: string): string {
	return !name.trim() || name === UNSPECIFIED ? "이름 미정" : name;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

function text(value: unknown): string {
	return typeof value === "string" ? value : "";
}

function integer(value: unknown, label: string): number {
	if (typeof value !== "number" || !Number.isInteger(value) || value < 0)
		throw new Error(label);
	return value;
}

function parseMode(value: unknown): InterviewMode {
	if (value === "fast" || value === "thoughtful") return value;
	throw new Error("invalid mode");
}

function parseKind(value: unknown): IntroKind {
	if (value === "user" || value === "persona") return value;
	throw new Error("invalid kind");
}

function parseStatus(value: unknown): IntroStatus {
	if (
		value === "active" ||
		value === "applying" ||
		value === "choices" ||
		value === "done"
	)
		return value;
	throw new Error("invalid status");
}

function parseProfile(value: unknown): AgentInput {
	if (!isRecord(value)) throw new Error("invalid profile");
	const id = value["id"];
	if (typeof id !== "string" || !id) throw new Error("invalid profile");
	const rawInterests = value["interests"];
	const interests = Array.isArray(rawInterests)
		? rawInterests.filter((item): item is string => typeof item === "string")
		: [];
	const avatarId = value["avatarId"];
	const evolution = value["evolution"];
	return {
		id,
		name: text(value["name"]),
		role: text(value["role"]),
		personality: text(value["personality"]),
		voice: text(value["voice"]),
		profile: text(value["profile"]),
		appearance: text(value["appearance"]),
		interests,
		avatarId: typeof avatarId === "string" ? avatarId : null,
		evolution: evolution === "manual" ? "manual" : "adaptive",
	};
}

function parseChapters(value: unknown): IntroChapters {
	const row = isRecord(value) ? value : {};
	return {
		identity: text(row["identity"]),
		values: text(row["values"]),
		temperament: text(row["temperament"]),
		interests: text(row["interests"]),
		relationship: text(row["relationship"]),
		expression: text(row["expression"]),
	};
}

function parseUser(value: unknown): IntroData["user"] {
	if (!isRecord(value)) return {};
	const user: IntroData["user"] = {};
	for (const key of [
		"address",
		"context",
		"interests",
		"communication",
		"boundaries",
		"currentFocus",
	] as const) {
		const item = value[key];
		if (typeof item === "string") user[key] = item;
	}
	return user;
}

function parseData(value: unknown): IntroData {
	if (!isRecord(value)) throw new Error("invalid data");
	const rawSummary = value["summary"];
	const summary = Array.isArray(rawSummary)
		? rawSummary.filter((item): item is string => typeof item === "string")
		: [];
	return {
		profile: parseProfile(value["profile"]),
		chapters: parseChapters(value["chapters"]),
		user: parseUser(value["user"]),
		...(value["userSkipped"] === undefined
			? {}
			: { userSkipped: parseUserSkipped(value["userSkipped"]) }),
		summary,
		ready: value["ready"] === true,
	};
}

export function parseRoom(value: unknown): IntroRoom {
	if (!isRecord(value)) throw new Error("invalid room");
	const id = value["id"];
	if (typeof id !== "string" || !isIntroUuid(id))
		throw new Error("invalid room");
	const draftId = value["draftId"];
	const finalization = value["finalization"];
	return {
		id,
		agentId: text(value["agentId"]),
		kind: parseKind(value["kind"]),
		status: parseStatus(value["status"]),
		revision: integer(value["revision"], "invalid revision"),
		mode: parseMode(value["mode"]),
		draftId: typeof draftId === "string" ? draftId : null,
		data: parseData(value["data"]),
		createdAt: integer(value["createdAt"], "invalid createdAt"),
		finalization: isRecord(finalization) ? finalization : null,
	};
}

export function parseTurn(value: unknown): IntroTurn {
	if (!isRecord(value)) throw new Error("invalid turn");
	const id = value["id"];
	if (typeof id !== "string" || !id) throw new Error("invalid turn");
	const requestId = value["requestId"];
	if (typeof requestId !== "string" || !isIntroUuid(requestId))
		throw new Error("invalid requestId");
	const statusValue = value["status"];
	if (
		statusValue !== "pending" &&
		statusValue !== "done" &&
		statusValue !== "failed"
	)
		throw new Error("invalid turn status");
	const rawSummary = value["summary"];
	const summary = Array.isArray(rawSummary)
		? rawSummary.filter((item): item is string => typeof item === "string")
		: [];
	const turnText = value["text"];
	const reply = value["reply"];
	const error = value["error"];
	return {
		id,
		requestId,
		seq: integer(value["seq"], "invalid seq"),
		text: turnText === null ? null : text(turnText),
		reply: reply === null || reply === undefined ? null : text(reply),
		status: statusValue,
		attempts: integer(value["attempts"], "invalid attempts"),
		error: error === null || error === undefined ? null : text(error),
		summary,
		createdAt: integer(value["createdAt"], "invalid createdAt"),
	};
}

export function parseSnapshot(value: unknown): IntroSnapshot {
	if (!isRecord(value)) throw new Error("invalid snapshot");
	const rawTurns = value["turns"];
	const turns = Array.isArray(rawTurns) ? rawTurns.map(parseTurn) : [];
	turns.sort((left, right) => left.seq - right.seq);
	const room = value["room"];
	const sessionId = value["sessionId"];
	const rawPresets = value["presets"];
	return {
		room: room === null || room === undefined ? null : parseRoom(room),
		turns,
		userRevision: integer(value["userRevision"], "invalid userRevision"),
		shareUser: value["shareUser"] === true,
		presets: Array.isArray(rawPresets) ? rawPresets.map(parseProfile) : [],
		sessionId: typeof sessionId === "string" ? sessionId : null,
	};
}

export function parseEntry(value: unknown): IntroEntry {
	if (!isRecord(value)) throw new Error("invalid entry");
	const resumeValue = value["resume"];
	let resume: IntroEntry["resume"] = null;
	if (isRecord(resumeValue)) {
		const id = resumeValue["id"];
		const agentId = resumeValue["agentId"];
		if (
			typeof id === "string" &&
			isIntroUuid(id) &&
			typeof agentId === "string"
		)
			resume = { id, agentId };
	}
	const rawDrafts = value["legacyDrafts"];
	const legacyDrafts: LegacyDraftRef[] = Array.isArray(rawDrafts)
		? rawDrafts.flatMap((item) => {
				if (!isRecord(item)) return [];
				const id = item["id"];
				if (typeof id !== "string" || !isIntroUuid(id)) return [];
				return [{ id, name: text(item["name"]) || "이름 미정" }];
			})
		: [];
	return {
		firstUser: value["firstUser"] === true,
		resume,
		legacyDrafts,
	};
}

export function parseChooseResult(value: unknown): ChooseResult {
	if (!isRecord(value)) throw new Error("invalid choose result");
	const agentId = value["agentId"];
	if (typeof agentId !== "string" || !/^[a-z][a-z0-9-]{0,47}$/.test(agentId))
		throw new Error("invalid choose result");
	const rawRoomId = value["roomId"];
	const roomId =
		typeof rawRoomId === "string" && isIntroUuid(rawRoomId) ? rawRoomId : null;
	const url = roomId ? introRoomUrl(roomId) : ordinaryAgentUrl(agentId);
	return { agentId, roomId, url };
}

export function shouldStartOpening(snapshot: IntroSnapshot): boolean {
	return snapshot.room?.status === "active" && snapshot.turns.length === 0;
}

export function latestFailedTurn(turns: IntroTurn[]): IntroTurn | undefined {
	const last = turns.at(-1);
	return last?.status === "failed" ? last : undefined;
}

export function bubblesFromTurns(
	turns: IntroTurn[],
	local: { stoppedRequestId?: string | null; inFlight?: boolean } = {},
): IntroBubble[] {
	const bubbles: IntroBubble[] = [];
	for (const turn of turns) {
		if (turn.text !== null) {
			bubbles.push({
				id: turn.id + "-user",
				turnId: turn.id,
				requestId: turn.requestId,
				role: "user",
				text: turn.text,
				state: "done",
				error: null,
			});
		}
		const stopped = local.stoppedRequestId === turn.requestId;
		const preparing =
			turn.status === "pending" ||
			(local.inFlight === true && turn === turns.at(-1));
		if (turn.status === "failed") {
			bubbles.push({
				id: turn.id + "-assistant",
				turnId: turn.id,
				requestId: turn.requestId,
				role: "assistant",
				text: turn.reply ?? "",
				state: stopped ? "stopped" : "failed",
				error: stopped ? null : turn.error,
			});
			continue;
		}
		if (preparing && !turn.reply) {
			bubbles.push({
				id: turn.id + "-assistant",
				turnId: turn.id,
				requestId: turn.requestId,
				role: "assistant",
				text: "응답 준비 중",
				state: stopped ? "stopped" : "preparing",
				error: null,
			});
			continue;
		}
		if (turn.reply !== null) {
			bubbles.push({
				id: turn.id + "-assistant",
				turnId: turn.id,
				requestId: turn.requestId,
				role: "assistant",
				text: turn.reply,
				state: turn.status === "pending" ? "pending" : "done",
				error: null,
			});
		}
	}
	return bubbles;
}

export function retryRequest(
	turns: IntroTurn[],
	text: string | null,
	uuid: () => string,
	persisted?: { requestId: string; text: string | null } | null,
): { requestId: string; text: string | null } {
	const last = turns.at(-1);
	if (last && last.status === "failed" && last.text === text)
		return { requestId: last.requestId, text: last.text };
	if (persisted && persisted.text === text && isIntroUuid(persisted.requestId))
		return persisted;
	return { requestId: uuid(), text };
}

export function composerSendable(
	text: string,
	busy: boolean,
	status: IntroStatus | undefined,
): boolean {
	const trimmed = text.trim();
	return (
		!busy &&
		status === "active" &&
		trimmed.length > 0 &&
		trimmed.length <= INTRO_TURN_LIMIT
	);
}

export function shareCheckbox(shareUser: boolean): boolean {
	return shareUser === true;
}

export async function resolveBoot(
	query: BootQuery,
	load: () => Promise<IntroEntry>,
): Promise<{ decision: BootDecision; notice: string }> {
	const initial = decideBoot(query);
	if (initial.kind !== "entry") return { decision: initial, notice: "" };
	try {
		return { decision: decideBoot(query, await load()), notice: "" };
	} catch {
		return {
			decision: { kind: "normal", agentId: "lina" },
			notice: "소개 안내를 잠시 불러오지 못했어요. 대화는 계속할 수 있습니다.",
		};
	}
}

import { parseUserSkipped } from "../../lina-core/src/onboarding/user-basics.ts";
