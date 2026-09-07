import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";

const { chromium } = await import(
	process.env.LINA_QA_PLAYWRIGHT_MODULE ?? "playwright"
);
const output = process.env.LINA_QA_OUTPUT ?? "/tmp/lina-task-layout-ux";
await mkdir(output, { recursive: true });
const browser = await chromium.launch({
	headless: true,
	...(process.env.LINA_QA_CHROMIUM
		? { executablePath: process.env.LINA_QA_CHROMIUM }
		: {}),
});
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
page.setDefaultTimeout(5000);
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
const layout = (value) =>
	page.waitForFunction(
		(value) => document.documentElement.dataset.layout === value,
		value,
		{ timeout: 5000 },
	);
try {
	await page.goto(process.env.LINA_QA_URL ?? "http://127.0.0.1:18160");
	await page.locator("#other-agents .agent-row").first().waitFor();
	assert.equal(
		await page.locator(".list-switch .icon-button").count(),
		0,
		"list tabs must not contain an ambiguous layout icon",
	);
	assert.equal(await page.locator("#collapse-sidebar").count(), 1);
	assert.equal(
		await page.locator("#toggle-task-column").isVisible(),
		false,
		"layout action belongs only to tasks",
	);
	await page.screenshot({ path: `${output}/agents.png` });
	await page.locator("#message").fill("목록 배치를 바꿔도 보존할 초안");
	await page.locator('.list-switch [data-screen="tasks"]').click();
	const toggle = page.locator("#task-pane #toggle-task-column");
	await toggle.waitFor();
	assert.equal(await toggle.innerText(), "나란히 보기");
	await page.locator("#task-list .task-link").first().waitFor();
	await page.locator("#task-scope").selectOption("all");
	await page.evaluate(() => {
		window.retainedTaskList = document.querySelector("#task-list");
	});
	await page.screenshot({ path: `${output}/tasks.png` });
	await toggle.click();
	await layout("dual");
	assert.equal(await toggle.innerText(), "나란히 보기 종료");
	assert.equal(await toggle.getAttribute("aria-pressed"), "true");
	assert.equal(await page.locator("#agent-pane").isVisible(), true);
	assert.equal(await page.locator("#task-column #task-pane").isVisible(), true);
	assert.equal(
		await page.locator("#close-task-column").count(),
		0,
		"one control owns the view choice",
	);
	await page.screenshot({ path: `${output}/together.png` });
	await toggle.click();
	await layout("single");
	assert.equal(await page.locator("#sidebar #task-pane").isVisible(), true);
	assert.equal(await page.locator("#task-scope").inputValue(), "all");
	assert.equal(
		await page.evaluate(
			() => window.retainedTaskList === document.querySelector("#task-list"),
		),
		true,
	);
	await page.waitForFunction(
		() => document.activeElement?.id === "toggle-task-column",
	);
	assert.equal(
		await page.locator("#message").inputValue(),
		"목록 배치를 바꿔도 보존할 초안",
	);
	await toggle.click();
	await layout("dual");
	await page.reload();
	await layout("dual");
	await toggle.waitFor();
	assert.equal(await toggle.innerText(), "나란히 보기 종료");
	await page.locator('.list-switch [data-screen="agents"]').click();
	await toggle.click();
	await layout("single");
	await page.waitForFunction(
		() =>
			document.activeElement ===
			document.querySelector('.list-switch [data-screen="agents"]'),
	);
	await page.locator('.list-switch [data-screen="tasks"]').click();
	// 1440px with a wide sidebar cannot fit both lists and the reading column.
	await page.locator("#sidebar-resizer").focus();
	await page.keyboard.press("End");
	await page.waitForFunction(
		() =>
			document.querySelector("#sidebar").getBoundingClientRect().width >= 419,
	);
	assert.equal(
		await toggle.isVisible(),
		false,
		"hide an unavailable split action, not an ineffective toggle",
	);
	await page.setViewportSize({ width: 1600, height: 900 });
	await toggle.waitFor();
	await toggle.click();
	await layout("dual");
	await page.setViewportSize({ width: 1280, height: 900 });
	await layout("single");
	assert.equal(await toggle.isVisible(), false);
	await page.setViewportSize({ width: 1600, height: 900 });
	await layout("dual");
	assert.equal(await toggle.innerText(), "나란히 보기 종료");
	await page.setViewportSize({ width: 390, height: 844 });
	await layout("mobile");
	assert.equal(await toggle.isVisible(), false);
	assert.equal(await page.locator("#task-pane").isVisible(), true);
	assert.equal(await page.locator("#collapse-sidebar").isVisible(), false);
	assert.ok(
		await page.evaluate(
			() => document.documentElement.scrollWidth <= innerWidth,
		),
	);
	await page.screenshot({ path: `${output}/mobile-tasks.png` });
	assert.deepEqual(errors, []);
	console.log(
		"PASS: contextual action, one toggle, active label, focus, retained list/filter/draft, reload, actual available width and mobile",
	);
} finally {
	await browser.close();
}
