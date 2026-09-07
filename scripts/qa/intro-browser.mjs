// Run against server.json printed by: bun scripts/qa/intro-live.ts --serve --trace
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
const evidence = {
	root,
	base,
	capturedAt: new Date().toISOString(),
	steps: [],
	errors: [],
	views: [],
	assetFailures: [],
};
try {
	const page = await browser.newPage({
		viewport: { width: 1440, height: 900 },
	});
	let sockets = 0;
	page.on("websocket", () => sockets++);
	page.on("pageerror", (e) => evidence.errors.push(e.message));
	page.on("response", (r) => {
		if (
			r.status() >= 400 &&
			/\.(?:css|js|woff2?|png|svg)(?:\?|$)/.test(r.url())
		)
			evidence.assetFailures.push({ url: r.url(), status: r.status() });
	});
	const capture = async (name) => {
		const view = await page.evaluate(() => ({
			url: location.href,
			viewport: { width: innerWidth, height: innerHeight },
			text: document.querySelector("#conversation-scroll").innerText,
			overflow: document.documentElement.scrollWidth > innerWidth + 1,
			targets: [
				...document.querySelectorAll(
					".intro-toolbar button,.intro-toolbar>a,.intro-toolbar summary,.intro-panel button",
				),
			]
				.filter((e) => e.getBoundingClientRect().width)
				.map((e) => ({
					text: e.innerText,
					height: e.getBoundingClientRect().height,
					width: e.getBoundingClientRect().width,
				})),
			focus: {
				text: document.activeElement?.textContent,
				visible: document.activeElement?.matches(":focus-visible"),
			},
		}));
		assert.equal(view.overflow, false);
		evidence.views.push({ name, ...view });
		await page.screenshot({ path: `${root}/${name}.png`, fullPage: true });
	};
	await page.goto(base);
	if (process.argv.includes("--setup")) {
		await page.locator("#intro-model-setup").waitFor();
		assert.equal(await page.locator("dialog[open]").count(), 0);
		const first = await page.evaluate(async () => {
			const response = await fetch("/api/agents/lina/intro");
			if (!response.ok) throw new Error(`intro snapshot: ${response.status}`);
			return response.json();
		});
		assert.equal(first.turns.length, 0);
		await capture("model-setup");
		await page.locator("#intro-model-setup").click();
		await page.locator("#model-default-input").fill("gpt-5.6-luna");
		await page
			.getByRole("option", { name: "gpt-5.6-luna · opencodex", exact: true })
			.click();
		const saved = page.waitForResponse(
			(r) =>
				r.url().endsWith("/api/models/settings") &&
				r.request().method() === "PATCH",
		);
		await page.locator("#model-save").click();
		assert.equal((await saved).status(), 200);
		await page.getByRole("button", { name: "설정 닫기", exact: true }).click();
		evidence.steps.push("unconfigured-model-setup-before-first-turn");
	}

	await page
		.locator("#messages .message.assistant .message-body")
		.first()
		.waitFor({ timeout: 80000 });
	await page.waitForFunction(
		() =>
			!document.querySelector("#intro-stop") ||
			document.querySelector("#intro-stop").hidden,
		null,
		{ timeout: 80000 },
	);
	assert.equal(sockets, 0);
	assert.match(page.url(), /onboarding=/);
	assert.equal(await page.locator("dialog[open]").count(), 0);
	evidence.steps.push("first-entry-chat-no-native-ws");
	await capture("first-desktop");
	for (const width of [1024, 768, 390, 320]) {
		await page.setViewportSize({ width, height: 900 });
		assert.equal(
			await page.evaluate(
				() => document.documentElement.scrollWidth > innerWidth + 1,
			),
			false,
		);
		await capture(`first-${width}`);
	}
	await page.locator('[data-intro-mode="fast"]').focus();
	await page.keyboard.press("Tab");
	assert.equal(
		await page
			.locator('[data-intro-mode="thoughtful"]')
			.evaluate((e) => e.matches(":focus-visible")),
		true,
	);
	await capture("focus-320");
	await page.setViewportSize({ width: 1440, height: 900 });
	await page.emulateMedia({ reducedMotion: "reduce" });
	await page.evaluate(() => {
		document.documentElement.dataset.theme = "light";
		document.documentElement.style.fontSize = "200%";
	});
	await capture("light-text-200");
	await page.evaluate(() => {
		document.documentElement.dataset.theme = "dark";
		document.documentElement.style.fontSize = "";
	});
	const text =
		"하린이라고 불러줘. 나는 도자기를 배우고 있어. 요즘 전시 준비가 고민이고, 먼저 공감해주고 질문은 하나씩 해주면 편해.";
	const response = page.waitForResponse(
		(r) => r.url().endsWith("/intro/turn") && r.request().method() === "POST",
		{ timeout: 80000 },
	);
	await page.locator("#message").fill(text);
	await page.locator("#send").click();
	assert.equal((await response).status(), 200);
	await page.waitForFunction(
		() => document.querySelector("#intro-stop").hidden,
		null,
		{ timeout: 80000 },
	);
	assert.equal(await page.locator(".message.user").count(), 1);
	await page.reload();
	await page.locator(".message.user").first().waitFor();
	assert.equal(await page.locator(".message.user").first().innerText(), text);
	evidence.steps.push("user-source-reload");
	await page.locator("[data-intro-action=review]").click();
	await page.locator("[data-intro-action=confirm-user]").click();
	await page
		.locator("[data-intro-action=choose-custom]")
		.waitFor({ timeout: 20000 });
	assert.equal(await page.locator("[data-intro-action=choose]").count(), 1);
	await capture("choices-desktop");
	await page.setViewportSize({ width: 390, height: 844 });
	await page
		.locator('[data-intro-action="choose-custom"]')
		.scrollIntoViewIfNeeded();
	await capture("choices-mobile");
	await page.setViewportSize({ width: 1440, height: 900 });
	evidence.steps.push("confirmed-lina-or-custom");
	await page.locator("#intro-share-user").check();
	await page.locator("[data-intro-action=choose-custom]").click();
	await page
		.locator("#chat-agent-name")
		.filter({ hasText: "이름 미정" })
		.waitFor({ timeout: 80000 });
	await page.waitForFunction(
		() =>
			document.querySelectorAll("#messages .message.assistant").length > 0 &&
			document.querySelector("#intro-stop").hidden,
		null,
		{ timeout: 80000 },
	);
	assert.equal(await page.locator("#message").count(), 1);
	assert.equal(await page.locator("dialog[open]").count(), 0);
	evidence.steps.push("unnamed-persona-chat");
	const turn = page.waitForResponse(
		(r) => r.url().endsWith("/intro/turn") && r.request().method() === "POST",
		{ timeout: 80000 },
	);
	await page
		.locator("#message")
		.fill(
			"너는 루아야. 오래된 등대를 지키는 동반자라는 설정이면 좋겠어. 차분하고 솔직하지만 가끔 건조한 농담을 해. 취미는 조개 지도 만들기고, 의견이 다르면 이유부터 듣는 친구였으면 해. 여기까지만 정하고 시작하자.",
		);
	await page.locator("#send").click();
	assert.equal((await turn).status(), 200);
	await page.waitForFunction(
		() => document.querySelector("#intro-stop").hidden,
		null,
		{ timeout: 80000 },
	);
	await page.setViewportSize({ width: 390, height: 844 });
	await page.locator(".message.assistant").last().scrollIntoViewIfNeeded();
	await capture("persona-mobile");
	const overflow = await page.evaluate(
		() => document.documentElement.scrollWidth > innerWidth + 1,
	);
	assert.equal(overflow, false);
	evidence.steps.push("mobile-no-overflow");
	await page.locator("[data-intro-action=review]").click();
	await page.locator("[data-intro-action=confirm-persona]").click();
	await page.waitForURL(/\?agent=/, { timeout: 30000 });
	await page.waitForFunction(
		() => document.querySelector("#connection-status").hidden,
		null,
		{ timeout: 30000 },
	);
	await page
		.locator("#message")
		.fill("내 호칭과 네 이름, 네가 지키는 장소를 한 문장으로 말해줘.");
	await page.locator("#send").click();
	await page.waitForFunction(
		() =>
			[...document.querySelectorAll(".message.assistant")].some(
				(e) =>
					e.textContent.includes("하린") &&
					e.textContent.includes("루아") &&
					e.textContent.includes("등대"),
			),
		null,
		{ timeout: 90000 },
	);
	evidence.steps.push("normal-answer-uses-intro-persona");
	evidence.answer = await page.locator(".message.assistant").last().innerText();
	assert.equal(evidence.errors.length, 0);
	assert.equal(evidence.assetFailures.length, 0);
	console.log(JSON.stringify(evidence));
} finally {
	fs.writeFileSync(
		root + "/browser-evidence.json",
		JSON.stringify(evidence, null, 2),
	);
	await browser.close();
}
