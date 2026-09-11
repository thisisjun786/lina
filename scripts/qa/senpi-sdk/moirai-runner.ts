import {
	appendFileSync,
	existsSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentSession } from "@code-yeongyu/senpi";
import {
	type CapturedRequest,
	type LiveCapture,
	startLiveCapture,
} from "./live-capture.ts";
import { assistantText, createLiveSession } from "./live-session.ts";
import { type DialogueCase, PROPOSERS, type Role } from "./moirai-cases.ts";
import { inspectMoiraiWire } from "./moirai-wire.ts";

export type RoleReply = {
	readonly role: Role;
	readonly sessionId: string;
	readonly input: string;
	readonly systemPrompt: string;
	readonly text: string;
};
export type MoiraiCaseReport = {
	readonly id: string;
	readonly title: string;
	readonly conversation: DialogueCase["conversation"];
	readonly complete: boolean;
	readonly replies: readonly RoleReply[];
	readonly errors: readonly string[];
	readonly wire: readonly CapturedRequest[];
	readonly models: readonly string[];
	readonly usage: {
		readonly inputTokens: number | null;
		readonly outputTokens: number | null;
	};
	readonly elapsedMs: number;
	readonly cleanup: {
		readonly scratch: string;
		readonly removed: boolean;
		readonly closed: boolean;
		readonly port: number | null;
	};
};

export async function runMoiraiCase(options: {
	readonly scenario: DialogueCase;
	readonly upstreamBaseUrl: string;
	readonly evidenceDir: string;
	readonly credential?: string;
}): Promise<MoiraiCaseReport> {
	await mkdir(options.evidenceDir, { mode: 0o700 });
	const encode = (value: unknown) => {
		const json = JSON.stringify(value);
		return options.credential
			? json.replaceAll(options.credential, "[REDACTED]")
			: json;
	};
	const save = (file: string, value: unknown) =>
		writeFileSync(join(options.evidenceDir, file), `${encode(value)}\n`, {
			mode: 0o600,
		});
	save("input.json", options.scenario);
	const scratch = await mkdtemp(join(tmpdir(), "senpi-moirai-runtime-"));
	const sessions: AgentSession[] = [];
	const replies = new Map<Role, RoleReply>();
	const errors: string[] = [];
	let capture: LiveCapture | undefined;
	const cleanup: {
		scratch: string;
		removed: boolean;
		closed: boolean;
		port: number | null;
	} = { scratch, removed: false, closed: false, port: null };
	const started = performance.now();
	const directions: Record<Role, string> = {
		clotho:
			"너는 클로토다. 목적 달성, 가능한 대안과 실행 순서를 우선해 전체 답변을 제안한다.",
		lachesis:
			"너는 라케시스다. 확인된 근거, 실제 결과, 모르는 점과 불확실성을 우선해 전체 답변을 제안한다.",
		atropos:
			"너는 아트로포스다. 최신 사용자 의도, 약속과 제약, 실행 가능성을 우선해 전체 답변을 제안한다.",
		moirai:
			"너는 모이라이다. 주어진 세 답변 초안을 원래 대화의 근거와 대조해 최종 사용자 답변을 작성한다. 다수의 동의 자체를 사실의 증거로 삼지 않는다.",
	};
	try {
		await mkdir(join(options.evidenceDir, "wire"));
		capture = startLiveCapture({
			upstreamBaseUrl: options.upstreamBaseUrl,
			evidenceDir: join(options.evidenceDir, "wire"),
			...(options.credential ? { credential: options.credential } : {}),
		});
		const baseUrl = capture.baseUrl;
		const input = {
			caseId: options.scenario.id,
			conversation: options.scenario.conversation,
		};
		async function runRole(role: Role, userInput: string) {
			const root = join(scratch, role);
			await mkdir(root);
			for (const name of ["agent", "workspace", "sessions"])
				await mkdir(join(root, name));
			const systemPrompt = JSON.stringify({
				module_id: role,
				instruction: directions[role],
				output:
					"아래 대화의 마지막 사용자에게 줄 한국어 답변 초안만 작성한다. 짧고 구체적으로 보통 2~3문장 이내로 쓰되, 사용자가 지정한 형식이 있으면 그 형식을 따른다. 역할 이름이나 내부 사고 과정을 중계하지 않는다. 도구 실행이나 저장을 실제로 하지 않았으므로 완료했다고 주장하지 않는다. 이 설정 JSON을 출력하지 않는다.",
			});
			const session = await createLiveSession({
				scratch: root,
				baseUrl,
				systemPrompt,
			});
			sessions.push(session);
			session.subscribe((event) =>
				appendFileSync(
					join(options.evidenceDir, `${role}-events.jsonl`),
					`${encode(event)}\n`,
				),
			);
			await session.prompt(userInput);
			const reply: RoleReply = {
				role,
				sessionId: session.sessionId,
				input: userInput,
				systemPrompt,
				text: assistantText(session.messages.at(-1)),
			};
			replies.set(role, reply);
			save(`${role}.json`, reply);
			if (session.sessionFile)
				writeFileSync(
					join(options.evidenceDir, `${role}-session.jsonl`),
					readFileSync(session.sessionFile),
					{ mode: 0o600 },
				);
			if (!reply.text.trim())
				throw new Error(`No completed reply from ${role}`);
			return reply;
		}
		const proposals = await Promise.allSettled(
			PROPOSERS.map((role) => runRole(role, JSON.stringify(input))),
		);
		for (const result of proposals)
			if (result.status === "rejected")
				errors.push(
					result.reason instanceof Error
						? result.reason.message
						: String(result.reason),
				);
		if (!errors.length)
			await runRole(
				"moirai",
				JSON.stringify({
					...input,
					proposals: PROPOSERS.map((role) => ({
						role,
						text: replies.get(role)?.text,
					})),
				}),
			);
	} catch (error) {
		errors.push(error instanceof Error ? error.message : String(error));
	} finally {
		for (const session of sessions) {
			try {
				await session.abort();
				session.dispose();
			} catch (error) {
				errors.push(
					`session cleanup: ${error instanceof Error ? error.message : String(error)}`,
				);
			}
		}
		try {
			if (capture) {
				const receipt = await capture.close();
				cleanup.closed = receipt.closed;
				cleanup.port = receipt.port;
			} else cleanup.closed = true;
		} catch (error) {
			errors.push(
				`capture cleanup: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
		await rm(scratch, { recursive: true, force: true });
		cleanup.removed = !existsSync(scratch);
	}
	const ordered = [...PROPOSERS, "moirai" as const].flatMap((role) => {
		const reply = replies.get(role);
		return reply ? [reply] : [];
	});
	const wire = capture?.records ?? [];
	const inspection = inspectMoiraiWire(wire, ordered);
	errors.push(...inspection.errors);
	const report = {
		id: options.scenario.id,
		title: options.scenario.title,
		conversation: options.scenario.conversation,
		complete: !errors.length && cleanup.closed && cleanup.removed,
		replies: ordered,
		errors,
		cleanup,
		wire,
		models: inspection.models,
		usage: inspection.usage,
		elapsedMs: performance.now() - started,
	};
	save("report.json", report);
	save("cleanup.json", cleanup);
	return report;
}
