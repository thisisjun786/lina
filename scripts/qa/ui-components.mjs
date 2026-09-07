import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";

const { chromium } = await import(
	process.env.LINA_QA_PLAYWRIGHT_MODULE ?? "playwright"
);
const output = process.env.LINA_QA_OUTPUT ?? "/tmp/lina-ui-components";
await mkdir(output, { recursive: true });
const browser = await chromium.launch({
	headless: true,
	...(process.env.LINA_QA_CHROMIUM
		? { executablePath: process.env.LINA_QA_CHROMIUM }
		: {}),
});
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
try {
	await page.goto(process.env.LINA_QA_URL ?? "http://127.0.0.1:18150");
	await page.locator("#other-agents .agent-link").first().waitFor();
	for (const [trigger, menu] of [
		["#account-button", "#account-menu"],
		["#other-agents .agent-more", "#agent-actions"],
	]) {
		for (const key of ["Tab", "Shift+Tab"]) {
			const button = page.locator(trigger).first();
			await button.focus();
			await page.keyboard.press(key);
			await page.evaluate(() => {
				window.expectedTabTarget = document.activeElement;
			});
			await button.click();
			await page.locator(menu).waitFor();
			await page.keyboard.press(key);
			await page.locator(menu).waitFor({ state: "hidden", timeout: 2000 });
			await page.waitForFunction(
				() => document.activeElement === window.expectedTabTarget,
				undefined,
				{ timeout: 2000 },
			);
		}
	}
	await page.locator("#account-button").focus();
	await page.keyboard.press("ArrowUp");
	await page
		.locator("#account-menu")
		.waitFor({ state: "visible", timeout: 3000 });
	await page.waitForFunction(
		() => document.activeElement?.id === "open-shortcuts",
	);
	await page.keyboard.press("Home");
	await page.waitForFunction(
		() => document.activeElement?.id === "open-settings",
	);
	await page.keyboard.press("End");
	await page.waitForFunction(
		() => document.activeElement?.id === "open-shortcuts",
	);
	await page.keyboard.press("Escape");
	await page.waitForFunction(
		() => document.activeElement?.id === "account-button",
	);
	await page.locator("#account-button").click();
	await page.locator("#account-menu").waitFor();
	await page.locator("#account-button").click();
	await page
		.locator("#account-menu")
		.waitFor({ state: "hidden", timeout: 2000 });
	await page.locator("#account-button").click();
	await page.locator("#open-settings").click();
	await page.locator("#settings-dialog").waitFor();
	await page.keyboard.press("Escape");
	await page.locator("#settings-dialog").waitFor({ state: "hidden" });
	await page.locator("#message").fill("컴포넌트 전환 후에도 남아야 하는 초안");
	const more = page.locator("#other-agents .agent-more").first();
	await more.click();
	await page.locator("#agent-actions").waitFor();
	await page.keyboard.press("End");
	await page.waitForFunction(() => document.activeElement?.id === "open-mind");
	await page.keyboard.press("Escape");
	await page.waitForFunction(
		() =>
			document.querySelector("#other-agents .agent-more") ===
			document.activeElement,
	);
	await more.click();
	await page.locator("#agent-actions").waitFor();
	await page.locator("#message").click();
	await page.locator("#agent-actions").waitFor({ state: "hidden" });
	assert.equal(
		await page.locator("#message").inputValue(),
		"컴포넌트 전환 후에도 남아야 하는 초안",
	);
	await page.locator("#current-agent-settings").click();
	await page.locator("#edit-agent").click();
	await page.locator("#agent-dialog").waitFor();
	await page.waitForFunction(() =>
		document.querySelector("#agent-dialog")?.contains(document.activeElement),
	);
	assert.equal(
		await page
			.locator("#agent-dialog")
			.evaluate((e) => e.contains(document.activeElement)),
		true,
	);
	await page.keyboard.press("Escape");
	assert.deepEqual(errors, []);
	console.log(
		"PASS shared menus: keyboard entry, roving focus, escape, dialog handoff, outside dismissal, draft retention",
	);
} finally {
	await browser.close();
}
