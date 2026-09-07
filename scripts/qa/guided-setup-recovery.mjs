// Isolated unconfigured intro-live server: first setup, Lina creation, reload and setup access.
import assert from "node:assert/strict";
import fs from "node:fs";

const { chromium } = await import(
	process.env.LINA_PLAYWRIGHT_MODULE ?? "playwright"
);
const { root, base } = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
assert.match(root, /^\/tmp\/lina-onboarding-live-[a-zA-Z0-9]+$/);
assert.match(base, /^http:\/\/127\.0\.0\.1:[0-9]+$/);
const browser = await chromium.launch({
	executablePath: process.env.LINA_CHROMIUM_PATH,
	headless: true,
	args: ["--no-sandbox"],
});
const proof = { root, base, views: [], errors: [] };
try {
	const page = await browser.newPage({
		viewport: { width: 1440, height: 900 },
	});
	page.on("pageerror", (e) => proof.errors.push(e.message));
	const layout = async (label) => {
		for (const width of [1440, 1024, 768, 390, 320]) {
			await page.setViewportSize({ width, height: 900 });
			for (const id of [
				"sidebar",
				"sidebar-resizer",
				"sidebar-drawer",
				"open-sidebar",
			])
				assert.equal(await page.locator(`#${id}`).isVisible(), false);
			assert.equal(
				await page
					.locator(
						"#open-onboarding, .intro-entry-link, #open-agent-onboarding",
					)
					.count(),
				0,
			);
			assert.equal(
				await page.getByText("평소 대화로", { exact: true }).count(),
				0,
			);
			assert.equal(
				await page.evaluate(
					() => document.documentElement.scrollWidth > innerWidth + 1,
				),
				false,
			);
			await page.screenshot({ path: `${root}/${label}-${width}.png` });
			proof.views.push({ label, width });
		}
	};
	// Hold boot response: sidebar must already be absent before the first entry response.
	let release;
	const gate = new Promise((r) => {
		release = r;
	});
	await page.route("**/api/onboarding/entry", async (r) => {
		await gate;
		await r.continue();
	});
	await page.goto(base, { waitUntil: "domcontentloaded" });
	assert.equal(await page.locator("#sidebar").isVisible(), false);
	release();
	await page.locator("#intro-model-setup").waitFor();
	await page.unroute("**/api/onboarding/entry");
	await layout("first-unconfigured");
	await page.locator("#intro-model-setup").click();
	await page.locator("#settings-dialog[open]").waitFor();
	assert.equal(await page.locator("#model-scope").inputValue(), "lina");
	await page.keyboard.press("Escape");
	await page.locator("#settings-dialog[open]").waitFor({ state: "hidden" });
	assert.equal(
		await page
			.locator("#intro-model-setup")
			.evaluate((e) => e === document.activeElement),
		true,
	);
	await page.locator("[data-intro-action=skip]").click();
	await page.locator("[data-intro-action=choose-custom]").click();
	await page.waitForFunction(
		() =>
			document.querySelector(".intro-kicker")?.textContent ===
			"새 에이전트 만들기",
	);
	await page.locator("#intro-model-setup").waitFor();
	const creationUrl = page.url();
	await page.goto(base);
	await page.locator("#intro-model-setup").waitFor();
	assert.equal(page.url(), creationUrl);
	assert.equal(await page.locator("#chat-agent-name").innerText(), "리나");
	await layout("creation-unconfigured");
	await page.locator("#intro-model-setup").click();
	await page.locator("#settings-dialog[open]").waitFor();
	assert.equal(await page.locator("#model-scope").inputValue(), "lina");
	await page.keyboard.press("Escape");
	assert.equal(proof.errors.length, 0);
	proof.creationUrl = creationUrl;
	console.log(JSON.stringify(proof));
} finally {
	fs.writeFileSync(
		`${root}/guided-recovery.json`,
		JSON.stringify(proof, null, 2),
	);
	await browser.close();
}
