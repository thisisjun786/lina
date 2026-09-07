import { expect, test } from "bun:test";
import { OpenCodexError, sanitizeMessage } from "../src/errors.ts";

test("sanitizeMessage redacts supplied secrets and known credential forms", () => {
	const token = "ocx_live_super_secret_value_zzz";
	const bearer = "Authorization: Bearer sk-live-abcdefghijklmnopqrstuvwxyz";
	const apiKey = "sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789ABCD";
	const message = sanitizeMessage(
		`failed ${bearer} token=${token} key=${apiKey}`,
		[token],
	);
	expect(message).not.toContain(token);
	expect(message).not.toContain("sk-live-abcdefghijklmnopqrstuvwxyz");
	expect(message).not.toContain(apiKey);
	expect(message).toContain("[redacted]");
});

test("sanitizeMessage keeps env names and long model ids that are not secrets", () => {
	const model = "claude-3-5-sonnet-20241022";
	const envName = "LINA_OPENCODEX_TOKEN_FILE";
	const message = sanitizeMessage(
		`Remote OpenCodex Hub requires LINA_OPENCODEX_API_KEY or ${envName} for ${model}`,
	);
	expect(message).toContain(envName);
	expect(message).toContain("LINA_OPENCODEX_API_KEY");
	expect(message).toContain(model);
	expect(message).not.toContain("[redacted]");
});

test("OpenCodexError constructor still redacts known credential forms", () => {
	const error = new OpenCodexError(
		"provider_auth",
		"failed Authorization: Bearer super-secret-token-value",
	);
	expect(error.message).not.toContain("super-secret-token-value");
	expect(error.message).toContain("[redacted]");
});
