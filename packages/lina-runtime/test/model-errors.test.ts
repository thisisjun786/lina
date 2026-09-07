import { expect, test } from "bun:test";
import { modelFailure } from "../src/models/errors.ts";

test("provider errors expose actionable categories without echoing credentials or raw responses", () => {
	expect(
		modelFailure("Codex error: The usage limit has been reached").message,
	).toContain("사용량 한도");
	expect(
		modelFailure("401 Unauthorized Bearer secret-value").message,
	).toContain("인증");
	expect(modelFailure("upstream failed sk-secret").message).not.toContain(
		"sk-secret",
	);
});

test("background processing can persist a safe provider category", () => {
	expect(modelFailure("429 secret").code).toBe("provider_quota");
	expect(modelFailure("401 secret").code).toBe("provider_auth");
	expect(modelFailure("other secret").code).toBe("provider_error");
});
