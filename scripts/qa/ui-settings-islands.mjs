import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

// Run with Bun. Uses the real settings markup/styles and adapters without APIs.
const client = fileURLToPath(
	new URL("../../packages/lina-ui/client/", import.meta.url),
);
const out = process.env.LINA_QA_OUTPUT ?? "/tmp/lina-settings-islands";
const { chromium } = await import(
	process.env.LINA_QA_PLAYWRIGHT_MODULE ?? "playwright"
);
const build = await Bun.build({
	entrypoints: [
		"settings-islands-fixture",
		`${client}styles.css`,
		`${client}theme-boot.ts`,
	],
	target: "browser",
	define: { "process.env.NODE_ENV": '"production"' },
	minify: true,
	plugins: [
		{
			name: "settings-islands-fixture",
			setup(builder) {
				builder.onResolve({ filter: /^settings-islands-fixture$/ }, () => ({
					path: "fixture",
					namespace: "fixture",
				}));
				builder.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({
					loader: "js",
					contents: `
import { installSettingsTabs } from ${JSON.stringify(`${client}settings-tabs.ts`)};
import { installThemeControls } from ${JSON.stringify(`${client}theme-controls.ts`)};
const dialog = document.getElementById("settings-dialog");
const nav = dialog.querySelector(".settings-navigation");
nav.replaceChildren();
window.panelNodes = [...dialog.querySelectorAll('[role="tabpanel"]')];
window.changes = [];
window.tabs = installSettingsTabs(dialog, tab => window.changes.push(tab));
const original = dialog.querySelector(".theme-switch");
original.replaceChildren();
const duplicate = original.cloneNode(true);
duplicate.id = "intro-theme";
duplicate.removeAttribute("aria-labelledby");
duplicate.setAttribute("aria-label", "소개 화면 모드");
dialog.querySelector('#settings-panel-general').append(duplicate);
window.choiceHosts = [original, duplicate];
window.failures = 0;
installThemeControls(() => { window.failures++; });
dialog.showModal();
window.ready = true;
`,
				}));
			},
		},
	],
});
assert.ok(build.success, build.logs.map(String).join("\n"));
const assets = new Map(
	build.outputs.map((output) => [output.path.split("/").pop(), output]),
);
const html = (await Bun.file(`${client}index.html`).text())
	.replace('src="/app.js"', 'src="/settings-islands-fixture.js"')
	.replace('src="/theme.js"', 'src="/theme-boot.js"');
const server = Bun.serve({
	hostname: "127.0.0.1",
	port: 0,
	fetch(request) {
		const path = new URL(request.url).pathname.slice(1);
		if (!path)
			return new Response(html, { headers: { "Content-Type": "text/html" } });
		const asset = assets.get(path);
		return asset ? new Response(asset) : new Response(null, { status: 404 });
	},
});
const fixtureUrl = server.url.href;
console.log(`Settings islands fixture: ${fixtureUrl}`);
await mkdir(out, { recursive: true });
const browser = await chromium.launch({
	headless: true,
	...(process.env.LINA_QA_CHROMIUM
		? { executablePath: process.env.LINA_QA_CHROMIUM }
		: {}),
});
const results = [];
async function check(name, run, options = {}) {
	const context = await browser.newContext({
		viewport: { width: 1440, height: 900 },
		colorScheme: "light",
	});
	if (options.storage)
		await context.addInitScript((mode) => {
			if (mode === "get")
				Object.defineProperty(window, "localStorage", {
					get() {
						throw new DOMException("blocked", "SecurityError");
					},
				});
			else
				Storage.prototype.setItem = () => {
					throw new DOMException("full", "QuotaExceededError");
				};
		}, options.storage);
	const page = await context.newPage();
	page.setDefaultTimeout(5000);
	const errors = [];
	page.on("pageerror", (error) => errors.push(error.message));
	page.on("console", (message) => {
		if (message.type() === "error" && !message.text().includes("404"))
			errors.push(message.text());
	});
	try {
		await page.goto(server.url.href);
		await page.waitForFunction(() => window.ready);
		await run(page);
		assert.deepEqual(errors, []);
		results.push({ name, pass: true });
	} catch (error) {
		await page.screenshot({ path: `${out}/${results.length}-failure.png` });
		results.push({ name, pass: false, error: String(error), errors });
	} finally {
		await context.close();
	}
}
async function selected(page, tab) {
	await page.waitForFunction(
		(id) =>
			window.tabs.current === id &&
			document
				.getElementById(`settings-tab-${id}`)
				.getAttribute("aria-selected") === "true",
		tab,
	);
	assert.equal(
		await page.locator('[role="tabpanel"]:visible').getAttribute("id"),
		`settings-panel-${tab}`,
	);
	const orientation = await page
		.getByRole("tablist")
		.getAttribute("aria-orientation");
	const boxes = await page.getByRole("tab").evaluateAll((tabs) =>
		tabs.map((tab) => {
			const { x, y, width, height } = tab.getBoundingClientRect();
			return { x, y, width, height };
		}),
	);
	if (orientation === "vertical") {
		assert.equal(boxes[0].x, boxes[1].x, "vertical tab alignment");
		const listWidth = await page
			.getByRole("tablist")
			.evaluate((list) => list.getBoundingClientRect().width);
		assert.ok(
			boxes.every((box) => box.width === listWidth),
			"desktop tabs stretch to the full list width",
		);
		assert.ok(
			boxes[1].y >= boxes[0].y + boxes[0].height,
			"vertical tabs do not overlap",
		);
	} else {
		assert.equal(boxes[0].y, boxes[1].y, "horizontal tab alignment");
		assert.ok(
			boxes[1].x >= boxes[0].x + boxes[0].width,
			"horizontal tabs do not overlap",
		);
	}
}
await check(
	"desktop vertical keys, panel adapter, Home/End and select focus",
	async (page) => {
		const general = page.getByRole("tab", { name: "일반", exact: true });
		await general.focus();
		await general.press("ArrowRight");
		assert.equal(
			await page.evaluate(() => window.tabs.current),
			"general",
			"vertical tabs ignore ArrowRight",
		);
		await general.press("ArrowDown");
		await selected(page, "connections");
		assert.equal(
			await page.evaluate(() => document.activeElement.id),
			"settings-tab-connections",
		);
		assert.deepEqual(await page.evaluate(() => window.changes), [
			"connections",
		]);
		await page.keyboard.press("End");
		await selected(page, "models");
		await page.keyboard.press("ArrowDown");
		await selected(page, "general");
		await page.keyboard.press("End");
		await page.keyboard.press("Home");
		await selected(page, "general");
		await page.evaluate(() => {
			window.tabs.select("models", true);
			const content = document.querySelector(".settings-content");
			const tall = document.createElement("div");
			tall.style.height = "2000px";
			document.getElementById("settings-panel-models").append(tall);
			content.scrollTop = 120;
			window.tabs.select("models");
			window.sameScroll = content.scrollTop;
			window.tabs.select("connections", true);
		});
		assert.equal(await page.evaluate(() => window.sameScroll), 120);
		assert.equal(
			await page
				.locator(".settings-content")
				.evaluate((node) => node.scrollTop),
			0,
		);
		assert.equal(
			await page.evaluate(() => document.activeElement.id),
			"settings-tab-connections",
		);
		assert.equal(
			await page.evaluate(() =>
				window.panelNodes.every(
					(node) => node === document.getElementById(node.id),
				),
			),
			true,
		);
		assert.equal(await page.getByRole("tablist").count(), 1);
		for (const tab of ["general", "connections", "models"]) {
			assert.equal(
				await page
					.locator(`#settings-tab-${tab}`)
					.getAttribute("aria-controls"),
				`settings-panel-${tab}`,
			);
			assert.equal(
				await page
					.locator(`#settings-panel-${tab}`)
					.getAttribute("aria-labelledby"),
				`settings-tab-${tab}`,
			);
		}
		await page.screenshot({ path: `${out}/desktop.png` });
	},
);
await check(
	"mobile horizontal keys and live orientation resize",
	async (page) => {
		await page.setViewportSize({ width: 390, height: 844 });
		await page.waitForFunction(
			() =>
				document
					.querySelector('[role="tablist"]')
					.getAttribute("aria-orientation") === "horizontal",
		);
		const general = page.getByRole("tab", { name: "일반", exact: true });
		await general.focus();
		await general.press("ArrowDown");
		assert.equal(
			await page.evaluate(() => window.tabs.current),
			"general",
			"horizontal tabs ignore ArrowDown",
		);
		await general.press("ArrowRight");
		await selected(page, "connections");
		await page.keyboard.press("ArrowLeft");
		await selected(page, "general");
		await page.setViewportSize({ width: 1024, height: 768 });
		await page.waitForFunction(
			() =>
				document
					.querySelector('[role="tablist"]')
					.getAttribute("aria-orientation") === "vertical",
		);
		await page.keyboard.press("ArrowDown");
		await selected(page, "connections");
		await page.setViewportSize({ width: 390, height: 844 });
		await page.waitForFunction(
			() =>
				document
					.querySelector('[role="tablist"]')
					.getAttribute("aria-orientation") === "horizontal",
		);
		await page.screenshot({ path: `${out}/mobile.png` });
	},
);
async function theme(page, value, resolved) {
	await page.waitForFunction(
		({ value, resolved }) =>
			document.documentElement.dataset.theme === resolved &&
			document.querySelectorAll("[data-theme-choice]").length === 6 &&
			[...document.querySelectorAll("[data-theme-choice]")].every(
				(button) =>
					button.getAttribute("aria-pressed") ===
					String(button.dataset.themeChoice === value),
			),
		{ value, resolved },
	);
	assert.equal(
		await page.evaluate(
			() =>
				document.querySelector('meta[name="theme-color"]').content ===
				getComputedStyle(document.documentElement)
					.getPropertyValue("--surface-main")
					.trim(),
		),
		true,
	);
	assert.equal(
		await page.evaluate(
			() => getComputedStyle(document.documentElement).colorScheme,
		),
		resolved,
	);
}
await check(
	"empty theme hosts preserve labels, attributes, persistence and OS changes",
	async (page) => {
		await theme(page, "dark", "dark");
		assert.deepEqual(
			await page.locator("#intro-theme button").allTextContents(),
			["다크", "라이트", "시스템"],
		);
		assert.equal(
			await page.locator("#intro-theme").getAttribute("aria-label"),
			"소개 화면 모드",
		);
		assert.equal(
			await page
				.locator(".theme-switch")
				.first()
				.getAttribute("aria-labelledby"),
			"theme-label",
		);
		await page.locator('#intro-theme [data-theme-choice="light"]').click();
		await theme(page, "light", "light");
		assert.equal(
			await page.evaluate(() => localStorage.getItem("lina.theme.v1")),
			"light",
		);
		await page.reload();
		await page.waitForFunction(() => window.ready);
		await theme(page, "light", "light");
		await page.locator('#intro-theme [data-theme-choice="system"]').click();
		await theme(page, "system", "light");
		await page.emulateMedia({ colorScheme: "dark" });
		await theme(page, "system", "dark");
		assert.equal(
			await page.evaluate(() => localStorage.getItem("lina.theme.v1")),
			"system",
		);
		await page.locator('[data-theme-choice="light"]').first().click();
		await theme(page, "light", "light");
		await page.emulateMedia({ colorScheme: "light" });
		await page.emulateMedia({ colorScheme: "dark" });
		await theme(page, "light", "light");
		assert.equal(
			await page.evaluate(() =>
				window.choiceHosts.every(
					(host) => host.isConnected && host.children.length === 3,
				),
			),
			true,
		);
		await page.screenshot({ path: `${out}/theme-light.png` });
	},
);
for (const storage of ["get", "set"])
	await check(
		`theme remains usable when storage ${storage} throws`,
		async (page) => {
			await page.locator('[data-theme-choice="system"]').first().click();
			await theme(page, "system", "light");
			assert.equal(await page.evaluate(() => window.failures), 1);
			await page.emulateMedia({ colorScheme: "dark" });
			await theme(page, "system", "dark");
		},
		{ storage },
	);
await browser.close();
await server.stop(true);
await writeFile(
	`${out}/teardown.json`,
	JSON.stringify(
		{
			fixtureUrl,
			serverStopped: true,
			browserConnected: browser.isConnected(),
		},
		null,
		2,
	),
);
await writeFile(`${out}/results.json`, JSON.stringify(results, null, 2));
console.log(JSON.stringify(results, null, 2));
if (results.some((result) => !result.pass)) process.exitCode = 1;
