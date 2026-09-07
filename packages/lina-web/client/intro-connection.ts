import { resolveProfile } from "../../lina-runtime/src/models/selection.ts";
import {
	parseModelSettingsInput,
	validSettingsRevision,
} from "../../lina-runtime/src/models/validation.ts";
import type { IntroRequestFn } from "./intro-api.ts";

export type IntroConnection = { ready: boolean; message: string };
const record = (value: unknown): value is Record<string, unknown> =>
	!!value && typeof value === "object" && !Array.isArray(value);

/** Readiness is observational: it never picks a model, writes settings or invokes generation. */
export async function checkIntroConnection(
	request: IntroRequestFn,
	agentId: string,
): Promise<IntroConnection> {
	try {
		const value = await request("/api/models");
		if (
			!record(value) ||
			!record(value["settings"]) ||
			!Array.isArray(value["catalog"])
		)
			throw Error("invalid model state");
		const { revision, ...input } = value["settings"];
		const settings = {
			...parseModelSettingsInput(input),
			revision: validSettingsRevision(revision),
		};
		const selected = resolveProfile(settings, "conversation", agentId);
		if (!selected)
			return {
				ready: false,
				message: "반가워요. 대화를 시작하려면 사용할 모델을 먼저 골라주세요.",
			};
		if (selected.provider === "opencodex") {
			const hub = await request("/api/hub/status");
			if (!record(hub) || hub["connected"] !== true)
				return {
					ready: false,
					message:
						"모델 제공자에 연결하지 못했습니다. 설정에서 연결을 확인한 뒤 이어가세요.",
				};
		}
		const available = value["catalog"].some(
			(model: unknown) =>
				record(model) &&
				model["provider"] === selected.provider &&
				model["id"] === selected.model &&
				model["authenticated"] === true &&
				(model["supportedRoles"] === undefined ||
					(Array.isArray(model["supportedRoles"]) &&
						model["supportedRoles"].includes("conversation"))),
		);
		return available
			? { ready: true, message: "" }
			: {
					ready: false,
					message:
						"선택한 대화 모델을 사용할 수 없습니다. 연결된 모델을 다시 골라주세요.",
				};
	} catch {
		return {
			ready: false,
			message:
				"모델 설정을 불러오지 못했습니다. 연결을 확인하고 다시 시도해주세요.",
		};
	}
}
