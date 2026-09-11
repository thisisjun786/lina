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
import { atroposPrompt } from "./prompts/atropos.ts";
import { clothoPrompt } from "./prompts/clotho.ts";
import { lachesisPrompt } from "./prompts/lachesis.ts";
import { moiraiPrompt } from "./prompts/moirai.ts";

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
	const prompts: Record<Role, string> = {
		clotho: clothoPrompt,
		lachesis: lachesisPrompt,
		atropos: atroposPrompt,
		moirai: moiraiPrompt,
	};
	try {
		await mkdir(join(options.evidenceDir, "wire"));
		capture = startLiveCapture({
			upstreamBaseUrl: options.upstreamBaseUrl,
			evidenceDir: join(options.evidenceDir, "wire"),
			outputLimit: "provider-default",
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
			const systemPrompt = prompts[role];
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
			const message = session.messages.at(-1);
			const reply: RoleReply = {
				role,
				sessionId: session.sessionId,
				input: userInput,
				systemPrompt,
				text: assistantText(message),
			};
			replies.set(role, reply);
			save(`${role}.json`, reply);
			if (session.sessionFile)
				writeFileSync(
					join(options.evidenceDir, `${role}-session.jsonl`),
					readFileSync(session.sessionFile),
					{ mode: 0o600 },
				);
			if (
				message?.role !== "assistant" ||
				message.stopReason !== "stop" ||
				!reply.text.trim()
			)
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
					proposals: proposals
						.filter((result) => result.status === "fulfilled")
						.map((result) => result.value.text),
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
