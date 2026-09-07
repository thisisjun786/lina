export class ModelRequestError extends Error {
	constructor(
		message: string,
		readonly code: string = "provider_error",
	) {
		super(message);
	}
}
/** Only known categories cross into UI; raw provider responses may contain secrets. */
export function modelFailure(raw: string | undefined): ModelRequestError {
	if (raw && /usage limit|quota|rate.?limit|429/i.test(raw))
		return new ModelRequestError(
			"제공자 사용량 한도에 도달했습니다. 한도가 회복된 뒤 다시 시도하거나 다른 연결을 선택해주세요.",
			"provider_quota",
		);
	if (raw && /unauthorized|authentication|api.?key|401|403/i.test(raw))
		return new ModelRequestError(
			"제공자 인증을 확인해주세요. 기존 엔진 연결의 로그인 또는 API 키가 필요합니다.",
			"provider_auth",
		);
	return new ModelRequestError(
		"모델 응답을 완료하지 못했습니다. 연결과 선택한 모델을 확인해주세요.",
	);
}
