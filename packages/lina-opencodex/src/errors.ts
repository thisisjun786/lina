export class OpenCodexError extends Error {
	readonly code: string;
	readonly status?: number;
	constructor(code: string, message: string, status?: number) {
		super(sanitizeMessage(message));
		this.name = "OpenCodexError";
		this.code = code;
		if (status !== undefined) this.status = status;
	}
}

const CREDENTIAL_FORMS = [
	/\bbearer\s+\S+/gi,
	/\bsk-[a-z0-9_-]{8,}/gi,
	/\bocx_[a-z0-9_-]{8,}/gi,
];

export function sanitizeMessage(
	text: string,
	secrets: readonly string[] = [],
): string {
	let message = text;
	for (const secret of secrets) {
		if (!secret) continue;
		message = message.split(secret).join("[redacted]");
	}
	for (const pattern of CREDENTIAL_FORMS) {
		message = message.replace(pattern, "[redacted]");
	}
	return message;
}

export function httpError(
	status: number,
	secrets: readonly string[] = [],
): OpenCodexError {
	if (status === 401 || status === 403)
		return new OpenCodexError(
			"provider_auth",
			sanitizeMessage("OpenCodex 인증을 확인해주세요.", secrets),
			status,
		);
	if (status === 429)
		return new OpenCodexError(
			"provider_quota",
			sanitizeMessage("OpenCodex 사용량 한도에 도달했습니다.", secrets),
			status,
		);
	return new OpenCodexError(
		"provider_error",
		sanitizeMessage("OpenCodex 요청을 완료하지 못했습니다.", secrets),
		status,
	);
}
