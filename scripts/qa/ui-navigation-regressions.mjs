import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";

const { chromium } = await import(
	process.env.LINA_QA_PLAYWRIGHT_MODULE ?? "playwright"
);
const base = process.env.LINA_QA_URL ?? "http://127.0.0.1:18140";
const out = process.env.LINA_QA_OUTPUT ?? "/tmp/lina-ui-desktop-evidence";
await mkdir(out, { recursive: true });
const browser = await chromium.launch({
	headless: true,
	...(process.env.LINA_QA_CHROMIUM
		? { executablePath: process.env.LINA_QA_CHROMIUM }
		: {}),
});
const results = [];
async function check(name, run, blockedStorage = false) {
	const context = await browser.newContext({
		viewport: { width: 390, height: 844 },
	});
	if (blockedStorage)
		await context.addInitScript(() => {
			Storage.prototype.setItem = () => {
				throw new DOMException("full", "QuotaExceededError");
			};
		});
	const page = await context.newPage();
	const errors = [];
	page.on("pageerror", (e) => errors.push(e.message));
	try {
		await run(page);
		assert.deepEqual(errors, []);
		results.push({ name, pass: true });
	} catch (error) {
		await page.screenshot({
			path: `${out}/navigation-${results.length}-failure.png`,
		});
		results.push({ name, pass: false, error: String(error), errors });
	} finally {
		await context.close();
	}
}
await check("browser Back closes mobile settings", async (page) => {
	await page.goto(`${base}/?agent=lina&screen=agents`);
	await page.locator("#other-agents button").first().waitFor();
	await page.locator("#mobile-settings").click();
	await page.locator("#settings-dialog").waitFor({ state: "visible" });
	await page.goBack();
	assert.equal(new URL(page.url()).searchParams.get("screen"), "agents");
	assert.equal(await page.locator("#settings-dialog").isVisible(), false);
});
await check("new navigation cancels late intro selection", async (page) => {
	await page.goto(`${base}/?agent=lina&screen=agents`);
	await page
		.locator('#other-agents [data-agent-id="kai"] .agent-link')
		.waitFor();
	let release;
	const gate = new Promise((resolve) => {
		release = resolve;
	});
	await page.route("**/api/agents/kai/intro", async (route) => {
		await gate;
		await route.fulfill({
			contentType: "application/json",
			body: '{"room":null}',
		});
	});
	const sent = page.waitForRequest((request) =>
		request.url().endsWith("/api/agents/kai/intro"),
	);
	await page.locator('#other-agents [data-agent-id="kai"] .agent-link').click();
	await sent;
	await page.locator('.mobile-navigation [data-screen="tasks"]').click();
	const response = page.waitForResponse((response) =>
		response.url().endsWith("/api/agents/kai/intro"),
	);
	release();
	await (await response).finished();
	await page.evaluate(
		() => new Promise((resolve) => requestAnimationFrame(resolve)),
	);
	assert.equal(new URL(page.url()).searchParams.get("screen"), "tasks");
	assert.equal(new URL(page.url()).searchParams.get("agent"), "lina");
});
await check(
	"mobile conversation exposes search without a hardware keyboard",
	async (page) => {
		await page.goto(`${base}/?agent=lina`);
		await page.locator("#messages .message").first().waitFor();
		const buttons = page.getByRole("button", {
			name: "대화 검색",
			exact: true,
		});
		assert.equal(await buttons.count(), 1);
		await buttons.click();
		await page.locator("#search-dialog").waitFor({ state: "visible" });
	},
);
await check(
	"mobile reading anchor survives blocked storage and disconnected sockets",
	async (page) => {
		await page.goto(`${base}/?agent=lina`);
		await page.locator("#messages .message").first().waitFor();
		await page.locator("#conversation-scroll").evaluate((node) => {
			node.scrollTop = 380;
		});
		const top = await page
			.locator("#conversation-scroll")
			.evaluate((node) => node.scrollTop);
		await page.locator("#open-sidebar").click();
		await page
			.locator('#other-agents [data-agent-id="kai"] .agent-link')
			.click();
		await page.waitForFunction(() =>
			document.querySelector("#messages").textContent.includes("Kai의 대화"),
		);
		await page.locator("#open-sidebar").click();
		await page.evaluate(() => {
			window.originalSocket = WebSocket;
			window.WebSocket = class extends window.originalSocket {
				constructor(url) {
					super(url);
					this.close();
				}
			};
		});
		await page
			.locator('#other-agents [data-agent-id="lina"] .agent-link')
			.click();
		await page.waitForFunction(() =>
			document.querySelector("#messages").textContent.includes("Lina의 대화"),
		);
		await page.waitForFunction(
			(top) =>
				Math.abs(
					document.querySelector("#conversation-scroll").scrollTop - top,
				) < 3,
			top,
		);
		const restored = await page
			.locator("#conversation-scroll")
			.evaluate((node) => node.scrollTop);
		assert.ok(Math.abs(restored - top) < 3, `${top} → ${restored}`);
		assert.equal(await page.locator("#connection-status").isVisible(), true);
		await page.evaluate(() => {
			window.WebSocket = window.originalSocket;
		});
		await page.locator("#reconnect").click();
		await page.waitForFunction(
			() => document.querySelector("#connection-status").hidden,
		);
		assert.ok(
			Math.abs(
				(await page
					.locator("#conversation-scroll")
					.evaluate((node) => node.scrollTop)) - top,
			) < 3,
		);
	},
	true,
);
await browser.close();
await writeFile(
	`${out}/navigation-results.json`,
	JSON.stringify(results, null, 2),
);
console.log(JSON.stringify(results));
if (results.some((result) => !result.pass)) process.exitCode = 1;
