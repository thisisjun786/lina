import { startConversationApp } from "./conversation-app.ts";
import { introRequest } from "./intro-api.ts";
import { startIntroApp } from "./intro-app.ts";
import {
	ordinaryAgentUrl,
	parseBootQuery,
	parseEntry,
	parseSnapshot,
	resolveBoot,
} from "./intro-model.ts";
import { element, setText } from "./render.ts";

async function boot() {
	element("send", HTMLButtonElement).disabled = true;
	element("welcome", HTMLElement).hidden = true;
	const query = parseBootQuery(location.href);

	try {
		const { decision, notice } = await resolveBoot(query, async () =>
			parseEntry(await introRequest("/api/onboarding/entry")),
		);
		if (decision.kind === "normal") {
			if (query.onboarding) {
				location.replace(ordinaryAgentUrl(decision.agentId));
				return;
			}
			document.body.classList.remove("boot-pending");
			startConversationApp(notice);
			return;
		}
		if (decision.kind === "intro") {
			if (decision.intent === "room" && decision.roomId) {
				const snapshot = parseSnapshot(
					await introRequest(`/api/onboarding/rooms/${decision.roomId}`),
				);
				const room = snapshot.room;
				if (
					room &&
					(room.status === "done" ||
						(room.kind === "user" &&
							room.finalization?.["firstEntry"] !== true))
				) {
					const f = room.finalization;
					let id = room.agentId;
					if (room.kind === "user" && f?.["action"] === "choose") {
						if (typeof f["presetId"] === "string") id = f["presetId"];
						else if (typeof f["birthId"] === "string")
							id = `agent-${f["birthId"].replaceAll("-", "")}`;
					}
					// Recover a creation interrupted after first setup selection.
					if (room.kind === "user" && id !== "lina") {
						const creation = parseSnapshot(
							await introRequest(`/api/agents/${id}/intro`),
						);
						if (creation.room && creation.room.status !== "done") {
							location.replace(`/?onboarding=${creation.room.id}`);
							return;
						}
					}
					location.replace(ordinaryAgentUrl(id));
					return;
				}
			}
			document.body.classList.add("intro-active");
			document.body.classList.remove("boot-pending");
			await startIntroApp(decision);
		}
	} catch {
		const notice = element("notice", HTMLDivElement);
		notice.hidden = false;
		setText(
			notice,
			"대화를 불러오지 못했습니다. 연결을 확인하고 다시 시도해주세요.",
		);
		const retry = document.createElement("button");
		retry.type = "button";
		retry.className = "text-button";
		retry.textContent = "다시 불러오기";
		retry.addEventListener("click", () => location.reload());
		notice.append(retry);
		element("send", HTMLButtonElement).disabled = true;
	}
}
void boot();
