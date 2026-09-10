import { Buffer } from "node:buffer";

export const OUTPUT_CONTRACT =
	"JSON 객체 한 개만 반환하라. Markdown 코드 블록이나 앞뒤 해설은 금지한다. 원문 UTF-8은 최대 65536바이트다. 아래 키만 허용하고 중첩 객체도 닫힌 구조로 검사한다. 모든 필드는 필수다.\n\nproposer 필드는 roundId, snapshotId, proposalId, status, understanding, candidate, alternatives, support, assumptions, challenge, changeCondition, outcomeCheck, evidenceRequest다. 종합 필드는 roundId, snapshotId, status, understanding, candidate, alternatives, support, assumptions, challenge, changeCondition, outcomeCheck, evidenceRequest, consideredProposals, unresolved, replyDraft다. proposer에는 proposalId가 필수이며 종합 전용 필드는 금지한다. 종합에는 proposalId를 금지하고 consideredProposals, unresolved, replyDraft를 요구한다.\n\nroundId, snapshotId, proposalId, sourceRef는 공백만으로 이뤄지지 않은 1–128자 문자열이며 Host 기대값과 일치해야 한다. understanding, content, condition, claim, reasonNotChosen, reason은 공백만으로 이뤄지지 않은 1–4096자 문자열이다. challenge, changeCondition, outcomeCheck, evidenceRequest, replyDraft는 그 본문 문자열 또는 null이다. assumptions와 unresolved는 각 0–16개 본문 문자열이며 동일 문자열 중복을 금지한다. sourceRefs는 각 0–16개 식별자이며 목록 안 중복을 금지한다. Host가 제공한 현재 유효 출처만 허용한다. support의 sourceRefs는 최소 1개다. candidate는 null이거나 정확히 kind, content, preconditions다. preconditions는 0–8개이며 각 항목은 condition, sourceRefs다. 동일 condition 중복을 금지한다. alternatives는 0–1개이며 각 항목은 정확히 kind, content, reasonNotChosen, sourceRefs다. support는 0–16개이며 각 항목은 정확히 claim, sourceRefs다. 동일 claim 중복을 금지한다. consideredProposals는 정확히 3개이며 각 항목은 proposalId, disposition, reason이다. Host가 준 세 ID를 각각 한 번 포함한다. status는 ready, need_evidence, invalidated 중 하나다. kind는 respond, propose_effect, ask_user, defer 중 하나다. disposition은 use, revise, reject 중 하나다.\n\nroundId와 snapshotId는 Host가 준 값 그대로이며 자체 발급을 금지한다. proposalId는 proposer에만 적용하며 Host가 이번 호출에 발급한 값 그대로다. understanding은 현재 의도와 성공 조건의 짧은 요약이다. candidate.content는 답변, 행동 또는 질문이다. 단순 대화의 preconditions는 빈 배열이다. 무효화 시 candidate 전체가 null이다. alternatives는 선택하지 않은 다른 유효 후보를 최대 하나 기록한다. 불필요하면 빈 배열이다. support에는 출처 없는 추정을 넣지 않는다. assumptions는 아직 확인되지 않은 가정이다. challenge는 후보를 무너뜨릴 가장 중요한 반례나 실패 조건이며 없으면 null이다. changeCondition은 어떤 관찰이 결론을 바꿀지이며 불필요하면 null이다. outcomeCheck는 실행 후 확인할 관찰 가능 결과이며 실행 없는 단순 대화는 null이다. evidenceRequest는 부족한 정보와 필요한 이유이며 없으면 null이다. 도구 호출이나 실행 승인을 뜻하지 않는다. 확인되지 않은 조건은 sourceRefs를 비우고 assumptions에도 남긴다. unresolved는 아직 해결하지 못한 쟁점 목록이다. replyDraft는 사용자 응답 초안이거나 null이다.\n\nready는 candidate가 있고 evidenceRequest가 null이다. 형식상 판단을 제출했다는 뜻이며 실행 승인이나 참을 보장하지 않는다. need_evidence는 candidate.kind가 ask_user 또는 defer이고 evidenceRequest가 비어 있지 않다. 단순히 자료가 적다는 이유만으로 쓰지 않는다. invalidated는 candidate가 null, alternatives가 []이며 종합의 replyDraft는 null이다. 무효화 사유는 understanding에 쓴다. 사용자에게 이 JSON을 보여주지 않는다.";
const PROPOSER_KEYS = [
	"roundId",
	"snapshotId",
	"proposalId",
	"status",
	"understanding",
	"candidate",
	"alternatives",
	"support",
	"assumptions",
	"challenge",
	"changeCondition",
	"outcomeCheck",
	"evidenceRequest",
] as const;
const SYNTHESIS_KEYS = [
	"roundId",
	"snapshotId",
	"status",
	"understanding",
	"candidate",
	"alternatives",
	"support",
	"assumptions",
	"challenge",
	"changeCondition",
	"outcomeCheck",
	"evidenceRequest",
	"consideredProposals",
	"unresolved",
	"replyDraft",
] as const;
const STATUSES = ["ready", "need_evidence", "invalidated"] as const;
const KINDS = ["respond", "propose_effect", "ask_user", "defer"] as const;
const DISPOSITIONS = ["use", "revise", "reject"] as const;

export type JudgmentStatus = (typeof STATUSES)[number];
export type CandidateKind = (typeof KINDS)[number];
export type Disposition = (typeof DISPOSITIONS)[number];
export type JudgmentExpected = {
	roundId: string;
	snapshotId: string;
	sourceRefs: readonly string[];
	proposalId?: string;
	proposalIds?: readonly string[];
};
type SourceRefs = readonly string[];
export type JudgmentCandidate = {
	kind: CandidateKind;
	content: string;
	preconditions: readonly { condition: string; sourceRefs: SourceRefs }[];
};
export type JudgmentAlternative = {
	kind: CandidateKind;
	content: string;
	reasonNotChosen: string;
	sourceRefs: SourceRefs;
};
export type JudgmentSupport = { claim: string; sourceRefs: SourceRefs };
export type ConsideredProposal = {
	proposalId: string;
	disposition: Disposition;
	reason: string;
};
type SharedJudgment = {
	roundId: string;
	snapshotId: string;
	status: JudgmentStatus;
	understanding: string;
	candidate: JudgmentCandidate | null;
	alternatives: readonly JudgmentAlternative[];
	support: readonly JudgmentSupport[];
	assumptions: readonly string[];
	challenge: string | null;
	changeCondition: string | null;
	outcomeCheck: string | null;
	evidenceRequest: string | null;
};
export type ProposerJudgment = SharedJudgment & { proposalId: string };
export type SynthesisJudgment = SharedJudgment & {
	consideredProposals: readonly ConsideredProposal[];
	unresolved: readonly string[];
	replyDraft: string | null;
};
export type Judgment = ProposerJudgment | SynthesisJudgment;

function fail(): never {
	throw Error("Invalid judgment");
}
function closed(
	value: unknown,
	keys: readonly string[],
): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) fail();
	const record = value as Record<string, unknown>;
	if (
		Object.keys(record).length !== keys.length ||
		keys.some((key) => !Object.hasOwn(record, key))
	)
		fail();
	return record;
}
function oneOf<T extends string>(value: unknown, allowed: readonly T[]): T {
	return allowed.includes(value as T) ? (value as T) : fail();
}
function identifier(value: unknown): string {
	if (typeof value !== "string" || !value.trim() || value.length > 128) fail();
	return value;
}
function body(value: unknown): string {
	if (typeof value !== "string" || !value.trim() || value.length > 4096) fail();
	return value;
}
function nullableBody(value: unknown): string | null {
	return value === null ? null : body(value);
}
function unique(items: readonly string[]): void {
	if (new Set(items).size !== items.length) fail();
}
function sourceRefs(
	value: unknown,
	allowed: ReadonlySet<string>,
	min = 0,
): string[] {
	if (!Array.isArray(value) || value.length < min || value.length > 16) fail();
	const refs = value.map(identifier);
	unique(refs);
	if (refs.some((ref) => !allowed.has(ref))) fail();
	return refs;
}
function bodies(value: unknown): string[] {
	if (!Array.isArray(value) || value.length > 16) fail();
	const items = value.map(body);
	unique(items);
	return items;
}
function candidate(
	value: unknown,
	allowed: ReadonlySet<string>,
): JudgmentCandidate | null {
	if (value === null) return null;
	const record = closed(value, ["kind", "content", "preconditions"]);
	const preconditionsRaw = record["preconditions"];
	if (!Array.isArray(preconditionsRaw) || preconditionsRaw.length > 8) fail();
	const preconditions = preconditionsRaw.map((item) => {
		const row = closed(item, ["condition", "sourceRefs"]);
		return {
			condition: body(row["condition"]),
			sourceRefs: sourceRefs(row["sourceRefs"], allowed),
		};
	});
	unique(preconditions.map((item) => item.condition));
	return {
		kind: oneOf(record["kind"], KINDS),
		content: body(record["content"]),
		preconditions,
	};
}
function alternatives(
	value: unknown,
	allowed: ReadonlySet<string>,
): JudgmentAlternative[] {
	if (!Array.isArray(value) || value.length > 1) fail();
	return value.map((item) => {
		const row = closed(item, [
			"kind",
			"content",
			"reasonNotChosen",
			"sourceRefs",
		]);
		return {
			kind: oneOf(row["kind"], KINDS),
			content: body(row["content"]),
			reasonNotChosen: body(row["reasonNotChosen"]),
			sourceRefs: sourceRefs(row["sourceRefs"], allowed),
		};
	});
}
function support(
	value: unknown,
	allowed: ReadonlySet<string>,
): JudgmentSupport[] {
	if (!Array.isArray(value) || value.length > 16) fail();
	const items = value.map((item) => {
		const row = closed(item, ["claim", "sourceRefs"]);
		return {
			claim: body(row["claim"]),
			sourceRefs: sourceRefs(row["sourceRefs"], allowed, 1),
		};
	});
	unique(items.map((item) => item.claim));
	return items;
}
function considered(
	value: unknown,
	expectedIds: readonly string[],
): ConsideredProposal[] {
	if (!Array.isArray(value) || value.length !== 3) fail();
	const items = value.map((item) => {
		const row = closed(item, ["proposalId", "disposition", "reason"]);
		return {
			proposalId: identifier(row["proposalId"]),
			disposition: oneOf(row["disposition"], DISPOSITIONS),
			reason: body(row["reason"]),
		};
	});
	const ids = items.map((item) => item.proposalId);
	unique(ids);
	if ([...expectedIds].sort().join("\0") !== [...ids].sort().join("\0")) fail();
	return items;
}
function shared(
	record: Record<string, unknown>,
	expected: JudgmentExpected,
	allowed: ReadonlySet<string>,
) {
	const roundId = identifier(record["roundId"]);
	const snapshotId = identifier(record["snapshotId"]);
	if (roundId !== expected.roundId || snapshotId !== expected.snapshotId)
		fail();
	const status = oneOf(record["status"], STATUSES);
	const parsedCandidate = candidate(record["candidate"], allowed);
	const parsedAlternatives = alternatives(record["alternatives"], allowed);
	const evidenceRequest = nullableBody(record["evidenceRequest"]);
	if (status === "ready") {
		if (!parsedCandidate || evidenceRequest !== null) fail();
	} else if (status === "need_evidence") {
		if (
			!parsedCandidate ||
			(parsedCandidate.kind !== "ask_user" &&
				parsedCandidate.kind !== "defer") ||
			!evidenceRequest
		)
			fail();
	} else if (parsedCandidate || parsedAlternatives.length) fail();
	return {
		roundId,
		snapshotId,
		status,
		understanding: body(record["understanding"]),
		candidate: parsedCandidate,
		alternatives: parsedAlternatives,
		support: support(record["support"], allowed),
		assumptions: bodies(record["assumptions"]),
		challenge: nullableBody(record["challenge"]),
		changeCondition: nullableBody(record["changeCondition"]),
		outcomeCheck: nullableBody(record["outcomeCheck"]),
		evidenceRequest,
	};
}

export function parseJudgment(
	text: string,
	expected: JudgmentExpected,
): Judgment {
	if (
		typeof text !== "string" ||
		Buffer.byteLength(text) > 65536 ||
		text.trim() !== text
	)
		fail();
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch {
		fail();
	}
	const allowed = new Set(expected.sourceRefs);
	const proposalId = expected.proposalId;
	const proposalIds = expected.proposalIds;
	if ((proposalId == null) === (proposalIds == null)) fail();
	if (proposalIds) {
		if (proposalIds.length !== 3) fail();
		unique([...proposalIds].map(identifier));
		const record = closed(raw, SYNTHESIS_KEYS);
		const parsed = shared(record, expected, allowed);
		const replyDraft = nullableBody(record["replyDraft"]);
		if (parsed.status === "invalidated" && replyDraft !== null) fail();
		return {
			...parsed,
			consideredProposals: considered(
				record["consideredProposals"],
				proposalIds,
			),
			unresolved: bodies(record["unresolved"]),
			replyDraft,
		};
	}
	const record = closed(raw, PROPOSER_KEYS);
	const parsedId = identifier(record["proposalId"]);
	if (parsedId !== proposalId) fail();
	return { ...shared(record, expected, allowed), proposalId: parsedId };
}
