export interface HubManagement {
	status(): {
		configured: boolean;
		connected: boolean;
		guiUrl: string | null;
		error: string | null;
		modelCount: number;
	};
	refresh(signal?: AbortSignal): Promise<unknown>;
}
const reply = (data: unknown, status = 200) =>
	Response.json(data, {
		status,
		headers: {
			"Cache-Control": "no-store",
			"X-Content-Type-Options": "nosniff",
		},
	});
export async function hubRoutes(
	request: Request,
	hub: HubManagement,
	json: () => Promise<Record<string, unknown>>,
): Promise<Response | undefined> {
	const url = new URL(request.url);
	if (!/^\/api\/hub\/(status|refresh)$/.test(url.pathname)) return;
	if (url.search) return reply({ error: "요청 주소를 확인해주세요." }, 400);
	if (request.method === "GET" && url.pathname.endsWith("/status"))
		return reply(hub.status());
	if (request.method !== "POST" || !url.pathname.endsWith("/refresh"))
		return reply({ error: "지원하지 않는 요청입니다." }, 405);
	try {
		if (Object.keys(await json()).length)
			return reply({ error: "연결 설정은 OpenCodex에서 관리해주세요." }, 400);
	} catch {
		return reply({ error: "요청 내용을 확인해주세요." }, 400);
	}
	try {
		await hub.refresh(
			AbortSignal.any([request.signal, AbortSignal.timeout(10000)]),
		);
		return reply(hub.status());
	} catch {
		return reply(
			{
				...hub.status(),
				connected: false,
				error:
					"OpenCodex 모델 목록을 불러오지 못했습니다. 연결 상태를 확인해주세요.",
			},
			502,
		);
	}
}
