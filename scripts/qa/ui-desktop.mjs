import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

// Run against test/fixtures/ui-desktop.ts only. No live model or user data.
const { chromium } = await import(
	process.env.LINA_QA_PLAYWRIGHT_MODULE ?? "playwright"
);
const base = process.env.LINA_QA_URL ?? "http://127.0.0.1:18140";
const output = process.env.LINA_QA_OUTPUT ?? "/tmp/lina-ui-desktop-evidence";
await mkdir(output, { recursive: true });
const browser = await chromium.launch({
	headless: true,
	...(process.env.LINA_QA_CHROMIUM
		? { executablePath: process.env.LINA_QA_CHROMIUM }
		: {}),
});
const context = await browser.newContext({
	viewport: { width: 1440, height: 900 },
	permissions: ["clipboard-read", "clipboard-write"],
});
await context.tracing.start({ screenshots: true, snapshots: true });
const page = await context.newPage();
const errors = [];
const httpErrors = [];
page.on("response", (response) => {
	if (response.status() >= 400)
		httpErrors.push({ status: response.status(), url: response.url() });
});
page.on("pageerror", (error) => errors.push(error.message));
const row = (id) =>
	page.locator(`#other-agents [data-agent-id="${id}"] .agent-link`);
const screen = (value) =>
	page.waitForFunction(
		(value) => document.documentElement.dataset.screen === value,
		value,
	);
const agent = (id) =>
	page.waitForFunction(
		(id) =>
			new URL(location.href).searchParams.get("agent") === id &&
			document.querySelector("#messages .message"),
		id,
	);
const input = page.locator("#message");
const checks = [];
try {
	await page.goto(`${base}/?agent=lina`);
	await row("lina").waitFor();
	await page.locator("#send:not([disabled])").waitFor({ state: "hidden" });
	await page.locator("#messages .message").first().waitFor();
	const order = await page
		.locator("#other-agents .agent-row")
		.evaluateAll((rows) => rows.map((row) => row.dataset.agentId));
	assert.equal(order.length, 10);
	await input.fill("Lina에 남기는 한글 초안");
	await page.locator("#conversation-scroll").evaluate((node) => {
		node.scrollTop = 380;
	});
	const position = await page
		.locator("#conversation-scroll")
		.evaluate((node) => node.scrollTop);
	await row("kai").click();
	await agent("kai");
	await page.waitForFunction(() =>
		document.querySelector("#messages").textContent.includes("Kai의 대화"),
	);
	assert.equal(await input.inputValue(), "");
	await input.fill("Kai의 별도 초안");
	await row("lina").click();
	await agent("lina");
	assert.equal(await input.inputValue(), "Lina에 남기는 한글 초안");
	assert.ok(
		Math.abs(
			(await page
				.locator("#conversation-scroll")
				.evaluate((node) => node.scrollTop)) - position,
		) < 3,
		"reading anchor restored",
	);
	assert.deepEqual(
		await page
			.locator("#other-agents .agent-row")
			.evaluateAll((rows) => rows.map((row) => row.dataset.agentId)),
		order,
	);
	assert.equal(await page.evaluate(() => scrollY), 0);
	checks.push(
		"desktop in-page A→B→A preserves drafts, row order, reading anchor, one page",
	);
	await page.locator("#file-picker").setInputFiles({
		name: "ui-proof.txt",
		mimeType: "text/plain",
		buffer: Buffer.from("isolated attachment proof"),
	});
	await page.locator('#draft-files [data-attachment-state="ready"]').waitFor();
	await row("kai").click();
	await agent("kai");
	assert.equal(await input.inputValue(), "Kai의 별도 초안");
	await row("lina").click();
	await agent("lina");
	await page.locator('#draft-files [data-attachment-state="ready"]').waitFor();
	assert.ok(
		(await page.locator("#draft-files").innerText()).includes("ui-proof.txt"),
	);
	checks.push(
		"uploaded attachment reference survives switching with its owner",
	);
	await page
		.locator('#draft-files button[aria-label="ui-proof.txt 첨부 제외"]')
		.click();
	await input.fill("앞뒤");
	await input.evaluate((node) => node.setSelectionRange(1, 1));
	await page.evaluate(async () => {
		await navigator.clipboard.writeText(" 붙여넣은 한글\n둘째 줄 ");
	});
	await input.press("Control+V");
	await page.waitForFunction(() =>
		document.querySelector("#message").value.includes("둘째 줄"),
	);
	assert.equal(await input.inputValue(), "앞 붙여넣은 한글\n둘째 줄 뒤");
	await input.press("Control+Z");
	assert.equal(await input.inputValue(), "앞뒤");
	checks.push(
		"native Chromium clipboard text preserves selection, newline and Undo",
	);
	await page.evaluate(async () => {
		const canvas = document.createElement("canvas");
		canvas.width = canvas.height = 16;
		canvas.getContext("2d").fillRect(0, 0, 16, 16);
		const blob = await new Promise((resolve) =>
			canvas.toBlob(resolve, "image/png"),
		);
		await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
	});
	await input.press("Control+V");
	await page
		.locator('#draft-files [data-attachment-state="ready"] img')
		.waitFor();
	await page.locator("#send").click();
	await page.waitForFunction(() =>
		document
			.querySelector("#messages")
			.textContent.includes("UI 검증용 합성 데이터"),
	);
	await page.reload();
	await page.locator("#messages .message-files a").last().waitFor();
	checks.push(
		"native Chromium PNG paste→upload→explicit send→reloaded conversation file",
	);
	await page.screenshot({ path: join(output, "desktop.png") });
	await page.locator('.list-switch [data-screen="tasks"]').click();
	await page.locator("#toggle-task-column").click();
	await page.waitForFunction(
		() => document.documentElement.dataset.layout === "dual",
	);
	await page.locator("#task-column #task-list button").first().click();
	await page.locator("#task-dialog").waitFor({ state: "visible" });
	await page.waitForFunction(() =>
		document.querySelector("#task-heading").textContent.includes("로그인 오류"),
	);
	await page.locator("#task-input").fill("재시작 뒤에도 남는 작업 초안");
	await page.locator("#task-dialog [data-close]").first().click();
	await page.locator("#task-scope").selectOption("all");
	await page.locator("#toggle-task-column").click();
	await page.goto(`${base}/?agent=lina&task=task-1`);
	await page.locator("#task-dialog").waitFor({ state: "visible" });
	await page.reload();
	await page.locator("#task-dialog").waitFor({ state: "visible" });
	await page.waitForFunction(() =>
		document.querySelector("#task-heading").textContent.includes("로그인 오류"),
	);
	assert.equal(
		await page.locator("#task-input").inputValue(),
		"재시작 뒤에도 남는 작업 초안",
	);
	await page.locator("#task-dialog [data-close]").first().click();
	assert.equal(await page.locator("#task-scope").inputValue(), "all");
	checks.push("task input draft and all-owner filter survive document reload");
	assert.equal(new URL(page.url()).searchParams.has("task"), false);
	checks.push(
		"task direct link and reload preserve identity; closing returns to its list",
	);
	checks.push("explicit task column uses existing detail and return controls");
	await page.setViewportSize({ width: 390, height: 844 });
	await page.locator('.mobile-navigation [data-screen="agents"]').click();
	await screen("agents");
	assert.equal(await page.locator("#conversation").isVisible(), false);
	await page.locator("#agent-filter").fill("Kai");
	await row("kai").click();
	await screen("conversation");
	assert.equal(await input.inputValue(), "Kai의 별도 초안");
	assert.notEqual(
		await page.evaluate(() => document.activeElement.id),
		"message",
	);
	assert.equal(await page.locator(".mobile-navigation").isVisible(), false);
	await page.screenshot({ path: join(output, "mobile-conversation.png") });
	await page.locator("#open-sidebar").click();
	await screen("agents");
	assert.equal(await page.locator("#agent-filter").inputValue(), "Kai");
	await page.locator("#agent-filter").fill("");
	await page.screenshot({ path: join(output, "mobile-agents.png") });
	await page.locator("#mobile-settings").click();
	await page.locator("#settings-dialog").waitFor({ state: "visible" });
	await page.locator('[data-theme-choice="light"]').click();
	await page.locator("#settings-dialog [data-close]").first().click();
	await screen("agents");
	await page.goBack();
	assert.equal(await page.locator("#other-agents").isVisible(), true);
	checks.push(
		"390px list→chat→back restores filter/draft without opening keyboard; settings works",
	);
	await page.locator("#agent-filter").fill("");
	await row("lina").click();
	await screen("conversation");
	await page.setViewportSize({ width: 390, height: 500 });
	const allow = page.getByRole("button", { name: "허용", exact: true });
	await allow.waitFor();
	const approveBox = await allow.boundingBox();
	const sendBox = await page.locator("#send").boundingBox();
	assert.ok(
		approveBox && approveBox.y >= 0 && approveBox.y + approveBox.height <= 500,
	);
	assert.ok(sendBox && sendBox.y >= 0 && sendBox.y + sendBox.height <= 500);
	await page.getByRole("button", { name: "거절", exact: true }).click();
	await allow.waitFor({ state: "hidden" });
	await page.route("**/api/attachments", (route) =>
		route.fulfill({ status: 503, body: "synthetic failure" }),
	);
	await input.fill("실패해도 남아야 하는 본문");
	await page.locator("#file-picker").setInputFiles({
		name: "retry.txt",
		mimeType: "text/plain",
		buffer: Buffer.from("retry content"),
	});
	await page.locator('#draft-files [data-attachment-state="error"]').waitFor();
	assert.equal(await page.locator("#send").isDisabled(), true);
	await page.locator("#open-sidebar").click();
	assert.equal(new URL(page.url()).searchParams.get("screen"), "conversation");
	await page.unroute("**/api/attachments");
	await page.getByRole("button", { name: "retry.txt 첨부 재시도" }).click();
	await page.locator('#draft-files [data-attachment-state="ready"]').waitFor();
	assert.equal(await input.inputValue(), "실패해도 남아야 하는 본문");
	await page.getByRole("button", { name: "retry.txt 첨부 제외" }).click();
	assert.equal(
		await page.locator("#notice").isVisible(),
		false,
		"resolved attachment navigation warning clears",
	);
	checks.push(
		"390×500 reduced viewport keeps approval/send reachable; failed upload blocks send/navigation and retries safely",
	);
	await page.setViewportSize({ width: 390, height: 844 });
	await page.evaluate(() => {
		document.documentElement.style.fontSize = "200%";
	});
	assert.ok(
		await page.evaluate(
			() => document.documentElement.scrollWidth <= innerWidth,
		),
	);
	await page.screenshot({ path: join(output, "mobile-text-200.png") });
	await page.evaluate(() => {
		document.documentElement.style.fontSize = "";
	});
	for (const width of [320, 430, 768, 1024, 1280, 1920]) {
		await page.setViewportSize({ width, height: 900 });
		await page.waitForFunction(
			() => document.documentElement.scrollWidth <= innerWidth,
		);
		assert.ok(
			await page.evaluate(
				() => document.documentElement.scrollWidth <= innerWidth,
			),
		);
	}
	checks.push("320/430/768/1024/1280/1920 containment and light theme");
	if (process.env.LINA_QA_INTRO_URL) {
		const intro = await context.newPage();
		intro.on("pageerror", (error) => errors.push(error.message));
		await intro.setViewportSize({ width: 390, height: 844 });
		await intro.goto(process.env.LINA_QA_INTRO_URL);
		await intro.locator("#intro-setup").waitFor({ state: "visible" });
		await intro
			.getByText("반가워요. 대화를 시작하려면 사용할 모델을 먼저 골라주세요.")
			.waitFor();
		assert.equal(await intro.locator("#sidebar").isVisible(), false);
		assert.equal(await intro.locator(".mobile-navigation").isVisible(), false);
		assert.equal(await intro.locator("#composer-model").isVisible(), false);
		await intro.screenshot({ path: join(output, "onboarding-mobile.png") });
		checks.push(
			"first setup remains a sidebar-free conversation with the existing model connection recovery",
		);
		await intro.close();
	}
	assert.deepEqual(errors, []);
	await writeFile(
		join(output, "web-results.json"),
		JSON.stringify({ checks, errors, httpErrors }, null, 2),
	);
	console.log(
		JSON.stringify({ passed: checks.length, checks, errors, output }),
	);
} catch (error) {
	await page.screenshot({ path: join(output, "failure.png") });
	console.error(
		JSON.stringify({ error: String(error), errors, url: page.url() }),
	);
	throw error;
} finally {
	await context.tracing.stop({ path: join(output, "web-trace.zip") });
	await browser.close();
}
