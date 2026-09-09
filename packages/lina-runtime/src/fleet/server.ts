import { randomUUID } from "node:crypto";
import type { ServerWebSocket } from "bun";
import { defaultConversation } from "../persona/conversation.ts";
import type { GeneratedAvatarApplicationChecker } from "./agent-visual-routes.ts";
import { agentVisualRoutes } from "./agent-visual-routes.ts";
import type { GeneratedAvatarAuthorityChecker } from "./avatar-assets.ts";
import { AvatarAssets } from "./avatar-assets.ts";
import { companionRoutes } from "./companion-routes.ts";
import { introRoutes } from "./intro-routes.ts";
import type { FleetLifeImages } from "./life-images.ts";
import { lifeRoutes } from "./life-routes.ts";
import { type AgentFleet, validAgentId } from "./manager.ts";
import { onboardingRoutes } from "./onboarding-routes.ts";

const HEADERS = {
	"Cache-Control": "no-store",
	"X-Content-Type-Options": "nosniff",
};
async function body(request: Request, max = 65536): Promise<Uint8Array> {
	if (Number(request.headers.get("content-length")) > max)
		throw Error("Body too large");
	const reader = request.body?.getReader();
	if (!reader) return new Uint8Array();
	const signal = AbortSignal.any([request.signal, AbortSignal.timeout(10000)]);
	const chunks: Uint8Array[] = [];
	let size = 0;
	const abort = () => void reader.cancel().catch(() => {});
	signal.addEventListener("abort", abort, { once: true });
	try {
		for (;;) {
			signal.throwIfAborted();
			const result = await reader.read();
			signal.throwIfAborted();
			if (result.done) break;
			size += result.value.length;
			if (size > max) throw Error("Body too large");
			chunks.push(result.value);
		}
		return Buffer.concat(chunks);
	} finally {
		signal.removeEventListener("abort", abort);
		void reader.cancel().catch(() => {});
	}
}
async function json(request: Request): Promise<Record<string, unknown>> {
	const value: unknown = JSON.parse(
		new TextDecoder().decode(await body(request)),
	);
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw Error("Invalid object");
	return value as Record<string, unknown>;
}
const response = (value: unknown, status = 200) =>
	Response.json(value, { status, headers: HEADERS });
type Peer = {
	target: string;
	upstream: WebSocket | undefined;
	pending: (string | Buffer)[];
};
export async function startFleetServer(
	fleet: AgentFleet,
	port: number,
	workspace: string,
	primaryId = "lina",
	options: {
		lazy?: boolean;
		lifeImages?: () => FleetLifeImages;
		/** Main-owned world/job proof; absent means generated avatar serving is denied. */
		generatedAvatarAuthority?: GeneratedAvatarAuthorityChecker;
		/** Main-owned world/job proof; absent means generated avatar application is denied. */
		generatedAvatarApplication?: GeneratedAvatarApplicationChecker;
		route?: (
			request: Request,
			json: () => Promise<Record<string, unknown>>,
		) => Promise<Response | undefined>;
	} = {},
) {
	if (!validAgentId(primaryId) || !fleet.agents.get(primaryId))
		throw Error("Unknown primary agent");
	const primary = options.lazy ? undefined : await fleet.app(primaryId),
		avatars = new AvatarAssets(
			fleet.root,
			fleet.agents,
			options.generatedAvatarAuthority ?? (() => false),
		);
	avatars.recoverAvatarTemps();
	avatars.migrateWorkspaceSeeds(workspace, fleet.presets);
	avatars.syncInventory();
	avatars.recoverReferenceTemps();
	avatars.migrateCapturedLegacy();
	const peers = new Set<ServerWebSocket<Peer>>();
	const server = Bun.serve<Peer>({
		hostname: "127.0.0.1",
		port,
		async fetch(request, server) {
			if (request.headers.has("origin"))
				return new Response("Forbidden", { status: 403 });
			const url = new URL(request.url);
			if (
				request.method === "POST" &&
				url.hostname === "127.0.0.1" &&
				request.headers.get("host") === url.host &&
				/^\/api\/life\/worlds\/[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,255}\/step$/.test(
					url.pathname,
				)
			) {
				// A step has multiple bounded native calls; the runner owns their deadlines and aborts.
				server.timeout(request, 0);
			}
			if (
				request.method === "POST" &&
				/^\/api\/(?:onboarding\/(?:interview|preview)|agents\/(?:birth|[a-z][a-z0-9-]{0,47}\/intro\/(?:turn|choose))|life\/(?:drafts\/[a-zA-Z0-9._-]+\/suggest|author-sessions(?:\/[a-zA-Z0-9._-]+\/open)?))$/.test(
					url.pathname,
				)
			)
				server.timeout(request, 75);
			try {
				const visual = await agentVisualRoutes(
					request,
					fleet,
					avatars,
					options.generatedAvatarApplication ?? (() => false),
					() => json(request),
				);
				if (visual) return visual;
				const life = await lifeRoutes(
					request,
					fleet,
					() => json(request),
					options.lifeImages,
				);
				if (life) return life;
				const extension = await options.route?.(request, () => json(request));
				if (extension) return extension;
				const intro = await introRoutes(request, fleet, () => json(request));
				if (intro) return intro;
				const onboarding = await onboardingRoutes(request, fleet, () =>
					json(request),
				);
				if (onboarding) return onboarding;
				const managed = await companionRoutes(request, fleet, () =>
					json(request),
				);
				if (managed) return managed;
				if (url.pathname === "/health")
					return response({
						ready: true,
						sessionId:
							(primary ?? fleet.opened(primaryId))?.binding.sessionId ?? null,
					});
				if (url.pathname === "/api/agents" && request.method === "GET")
					return response({ agents: fleet.summary(), presets: fleet.presets });
				if (url.pathname === "/api/agents" && request.method === "POST") {
					const value = await json(request),
						preset =
							typeof value["preset"] === "string"
								? fleet.presets.find((p) => p.id === value["preset"])
								: undefined;
					const id =
						typeof value["id"] === "string"
							? value["id"]
							: `agent-${randomUUID().slice(0, 8)}`;
					if (
						!validAgentId(id) ||
						Object.keys(value).some(
							(k) => !["preset", "id", "name"].includes(k),
						)
					)
						return response({ error: "에이전트 정보를 확인해주세요." }, 400);
					const base = preset ?? {
						name: "새 에이전트",
						role: "개인 에이전트",
						personality: "솔직하고 차분하며 사용자의 의도를 존중합니다.",
						voice: "자연스러운 한국어 해요체. 일에 맞춰 간결하게 말합니다.",
						profile: "",
						appearance: "",
						interests: [],
						avatarId: null,
						evolution: "adaptive" as const,
					};
					return response(
						fleet.agents.create({
							...base,
							id,
							name:
								typeof value["name"] === "string" ? value["name"] : base.name,
						}),
						201,
					);
				}

				const conversationRoute =
					/^\/api\/agents\/([a-z][a-z0-9-]{0,47})\/conversation(\/preferences\/reset)?$/.exec(
						url.pathname,
					);
				if (conversationRoute) {
					const id = conversationRoute[1] ?? "";
					if (!fleet.agents.get(id))
						return response({ error: "에이전트를 찾지 못했습니다." }, 404);
					if (request.method === "GET" && !conversationRoute[2])
						return response({
							profile: (() => {
								const p = fleet.conversations.get(id);
								return p.revision ? p : { ...p, ...defaultConversation(id) };
							})(),
							preferences: fleet.conversations.getPreferences(id),
						});
					const input = await json(request);
					if (typeof input["revision"] !== "number")
						return response({ error: "설정을 확인해주세요." }, 400);
					if (
						request.method === "POST" &&
						conversationRoute[2] &&
						Object.keys(input).every((k) => k === "revision")
					)
						return response(
							fleet.conversations.clearPreferences(id, input["revision"]),
						);
					if (
						request.method === "PATCH" &&
						!conversationRoute[2] &&
						Object.keys(input).every((k) => ["revision", "patch"].includes(k))
					)
						return response(
							fleet.conversations.update(
								id,
								input["revision"],
								(() => {
									const patch = input["patch"];
									if (
										!patch ||
										typeof patch !== "object" ||
										Array.isArray(patch)
									)
										throw Error("Invalid conversation patch");
									return fleet.conversations.get(id).revision === 0
										? { ...defaultConversation(id), ...patch }
										: patch;
								})(),
							),
						);
					return response({ error: "요청을 확인해주세요." }, 400);
				}
				const match =
					/^\/api\/agents\/([a-z][a-z0-9-]{0,47})(?:\/(avatar|revert|memory))?$/.exec(
						url.pathname,
					);
				if (match) {
					const id = match[1] ?? "",
						action = match[2],
						profile = fleet.agents.get(id);
					if (!profile)
						return response({ error: "에이전트를 찾지 못했습니다." }, 404);
					if (!action && request.method === "GET")
						return response({
							profile,
							dynamics: fleet.agents.dynamics(id),
							changes: fleet.agents.changes(id),
						});
					if (!action && request.method === "PATCH") {
						const value = await json(request);
						if (
							Object.keys(value).some(
								(k) => !["revision", "patch"].includes(k),
							) ||
							typeof value["revision"] !== "number" ||
							!value["patch"] ||
							typeof value["patch"] !== "object" ||
							Array.isArray(value["patch"])
						)
							return response({ error: "설정을 확인해주세요." }, 400);
						return response(
							fleet.agents.update(id, value["revision"], value["patch"]),
						);
					}
					if (action === "revert" && request.method === "POST") {
						const value = await json(request);
						if (
							Object.keys(value).some(
								(k) => !["revision", "changeId"].includes(k),
							) ||
							typeof value["revision"] !== "number" ||
							typeof value["changeId"] !== "number"
						)
							return response({ error: "변경을 확인해주세요." }, 400);
						return response(
							fleet.agents.revert(id, value["changeId"], value["revision"]),
						);
					}
					if (action === "memory" && request.method === "POST") {
						if (!(await fleet.initializeMemory(id, request.signal)))
							return response(
								{
									code:
										fleet.memoryBackend === "honcho"
											? "MEMORY_MIGRATION_REQUIRED"
											: "MEMORY_UNAVAILABLE",
									migrationRequired: fleet.memoryBackend === "honcho",
									error:
										fleet.memoryBackend === "honcho"
											? "기존 외부 기억은 아직 이전되지 않았습니다. 자체 기억 엔진으로 전환이 필요합니다."
											: "기억 학습이 비활성화되어 있거나 준비되지 않았습니다.",
								},
								409,
							);
						const app = await fleet.app(id);
						return response(app.memory.status());
					}
					if (action === "avatar" && request.method === "POST") {
						const revision = Number(request.headers.get("X-Lina-Revision"));
						if (
							!Number.isSafeInteger(revision) ||
							revision !== profile.revision
						)
							return response(
								{ error: "설정이 바뀌었습니다. 다시 열어주세요." },
								409,
							);
						const bytes = await body(request, 2097152),
							name = decodeURIComponent(
								request.headers.get("X-Lina-Filename") ?? "",
							);
						const asset = avatars.importManual(
							id,
							`upload-${profile.revision}`,
							bytes,
							name,
						);
						return response(
							fleet.agents.applyManualAvatarOnce(
								id,
								{
									requestKey: `upload-${profile.revision}`,
									expectedProfileRevision: revision,
									expectedVisualRevision: fleet.agents.visual(id).revision,
									asset,
									source: { kind: "upload" },
								},
								(value) => avatars.read(value.sha256)?.size === value.size,
							),
						);
					}
				}
				const avatar = /^\/api\/avatars\/([a-f0-9]{64})$/.exec(url.pathname);
				if (avatar && request.method === "GET") {
					const asset = avatars.read(avatar[1] ?? "");
					if (asset && avatars.globalAuthority(asset.sha256))
						return new Response(asset.bytes, {
							headers: { ...HEADERS, "Content-Type": asset.mime },
						});
					return new Response("Not found", { status: 404 });
				}
				if (url.pathname.startsWith("/api/attachments")) {
					const session =
						request.headers.get("X-Lina-Session") ??
						url.searchParams.get("sessionId") ??
						"";
					const app = await fleet.forSession(session);
					if (!app) return response({ error: "Unknown session" }, 403);
					const target = new URL(request.url);
					target.host = `127.0.0.1:${app.port}`;
					return fetch(new Request(target.href, request), {
						redirect: "manual",
					});
				}
				if (url.pathname === "/" || url.pathname === "/ws") {
					const id = url.searchParams.get("agent") ?? "lina";
					if (
						url.searchParams.size > (url.searchParams.has("agent") ? 1 : 0) ||
						!validAgentId(id)
					)
						return new Response("Invalid agent", { status: 400 });
					const app = await fleet.app(id);
					if (peers.size >= 32) return new Response("Busy", { status: 503 });
					return server.upgrade(request, {
						data: {
							target: `ws://127.0.0.1:${app.port}`,
							upstream: undefined,
							pending: [],
						},
					})
						? undefined
						: new Response("WebSocket required", { status: 400 });
				}
				return new Response("Not found", { status: 404 });
			} catch (error) {
				const text = error instanceof Error ? error.message : "";
				return response(
					{
						error: /revision|conflict|stale/i.test(text)
							? "다른 곳에서 설정이 바뀌었습니다. 다시 열어주세요."
							: "요청을 처리하지 못했습니다. 입력과 연결을 확인해주세요.",
					},
					/revision|conflict|stale/i.test(text) ? 409 : 400,
				);
			}
		},
		websocket: {
			idleTimeout: 0,
			maxPayloadLength: 65536,
			open(peer) {
				peers.add(peer);
				const socket = new WebSocket(peer.data.target);
				peer.data.upstream = socket;
				socket.addEventListener("open", () => {
					for (const frame of peer.data.pending.splice(0)) socket.send(frame);
				});
				socket.addEventListener("message", (e) => {
					if (peer.readyState === WebSocket.OPEN) peer.send(String(e.data));
				});
				socket.addEventListener("close", () => peer.close());
				socket.addEventListener("error", () => {
					socket.close();
					peer.close();
				});
			},
			message(peer, data) {
				if (
					peer.data.upstream?.readyState === WebSocket.CONNECTING &&
					peer.data.pending.length < 4
				) {
					peer.data.pending.push(data);
					return;
				}
				if (peer.data.upstream?.readyState !== WebSocket.OPEN) {
					peer.close(1013);
					return;
				}
				peer.data.upstream.send(data);
			},
			close(peer) {
				peers.delete(peer);
				peer.data.pending.length = 0;
				peer.data.upstream?.close();
			},
		},
	});
	return {
		port: server.port,
		async stop() {
			await server.stop(true);
			await fleet.close();
		},
	};
}
