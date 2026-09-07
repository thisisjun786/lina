// Run against an isolated --serve QA server after intro-browser.mjs.
import assert from "node:assert/strict";
import fs from "node:fs";

const { chromium } = await import(
	process.env.LINA_PLAYWRIGHT_MODULE ?? "playwright"
);
const { root, base } = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
assert.match(root, /^\/tmp\/lina-onboarding-live-[a-zA-Z0-9]+$/);
assert.match(base, /^http:\/\/127\.0\.0\.1:[0-9]+$/);
const browser = await chromium.launch({
	...(process.env.LINA_CHROMIUM_PATH
		? { executablePath: process.env.LINA_CHROMIUM_PATH }
		: {}),
	headless: true,
	args: ["--no-sandbox"],
});
const evidence = { root, base, steps: [], errors: [] };
try {
	const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
	page.on("pageerror", (error) => evidence.errors.push(error.message));
	await page.goto(base + "/?onboarding=user");
	await page.waitForFunction(
		() =>
			document.querySelector("#intro-stop")?.hidden &&
			document.querySelector("#messages .message"),
		null,
		{ timeout: 80000 },
	);
	if (await page.locator('[data-intro-action="retry"]').count()) {
		const done = page.waitForResponse(
			(r) => r.url().endsWith("/intro/turn") && r.request().method() === "POST",
			{ timeout: 80000 },
		);
		await page.locator('[data-intro-action="retry"]').first().click();
		assert.equal((await done).status(), 200);
	}
	await page.waitForFunction(
		() => document.querySelector("#intro-stop").hidden,
		null,
		{ timeout: 80000 },
	);
	const mode = page.waitForResponse((r) => r.url().endsWith("/intro/mode"));
	await page.locator('[data-intro-mode="fast"]').click();
	assert.equal((await mode).status(), 200);
	const source = "내 취미는 종이 지도 모으기야. 질문은 하나씩 해줘.";
	const started = page.waitForRequest(
		(r) => r.url().endsWith("/intro/turn") && r.method() === "POST",
	);
	await page.locator("#message").fill(source);
	await page.locator("#send").click();
	const body = (await started).postDataJSON();
	await page.waitForFunction(
		async (requestId) => {
			const state = await (await fetch("/api/agents/lina/intro")).json();
			return state.turns.some(
				(t) => t.requestId === requestId && t.status === "pending",
			);
		},
		body.requestId,
		{ timeout: 15000 },
	);
	await page.locator("#intro-stop").click();
	await page.waitForFunction(
		async (requestId) => {
			const state = await (await fetch("/api/agents/lina/intro")).json();
			return state.turns.some(
				(t) => t.requestId === requestId && t.status === "failed",
			);
		},
		body.requestId,
		{ timeout: 80000 },
	);
	await page.reload();
	const retry = page.locator(
		`[data-intro-action="retry"][data-request-id="${body.requestId}"]`,
	);
	await retry.waitFor();
	const before = await page.evaluate(async () =>
		(await fetch("/api/agents/lina/intro")).json(),
	);
	const failed = before.turns.find((t) => t.requestId === body.requestId);
	assert.equal(failed.text, source);
	assert.equal(failed.status, "failed");
	await page.screenshot({ path: root + "/cancel-reload.png", fullPage: true });
	const replay = page.waitForRequest(
		(r) => r.url().endsWith("/intro/turn") && r.method() === "POST",
	);
	const complete = page.waitForResponse(
		(r) => r.url().endsWith("/intro/turn") && r.request().method() === "POST",
		{ timeout: 80000 },
	);
	await retry.click();
	assert.equal((await replay).postDataJSON().requestId, body.requestId);
	const response = await complete;
	assert.equal(response.status(), 200);
	const after = await response.json();
	const restored = after.turns.find((t) => t.requestId === body.requestId);
	assert.equal(restored.id, failed.id);
	assert.equal(restored.status, "done");
	assert.equal(restored.attempts, failed.attempts + 1);
	assert.equal(after.turns.length, before.turns.length);
	evidence.steps.push("cancel-reload-same-uuid-retry-without-duplicate");
	evidence.receipt = {
		requestId: body.requestId,
		turnId: restored.id,
		attemptsBefore: failed.attempts,
		attemptsAfter: restored.attempts,
		source,
	};
	await page.waitForFunction(
		() => document.querySelector("#intro-stop").hidden,
		null,
		{ timeout: 80000 },
	);
	await page.locator('[data-intro-action="skip"]').click();
	await page
		.locator('[data-intro-action="choose"][data-preset-id="lina"]')
		.waitFor();
	assert.equal(await page.locator('[data-intro-action="choose"]').count(), 1);
	await page
		.locator('[data-intro-action="choose"][data-preset-id="lina"]')
		.click();
	await page.waitForURL(/\?agent=lina/, { timeout: 30000 });
	evidence.steps.push("fast-mode-skip-select-existing-lina");
	assert.equal(evidence.errors.length, 0);
	console.log(JSON.stringify(evidence));
} finally {
	fs.writeFileSync(
		root + "/recovery-evidence.json",
		JSON.stringify(evidence, null, 2),
	);
	await browser.close();
}
