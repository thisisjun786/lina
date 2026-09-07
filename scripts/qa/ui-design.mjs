import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

// Geometry and actual-render evidence for the shared UI. Use the synthetic fixture.
const { chromium } = await import(
	process.env.LINA_QA_PLAYWRIGHT_MODULE ?? "playwright"
);
const base = process.env.LINA_QA_URL ?? "http://127.0.0.1:18150";
const output = process.env.LINA_QA_OUTPUT ?? "/tmp/lina-ui-design-review";
await mkdir(output, { recursive: true });
const browser = await chromium.launch({
	headless: true,
	...(process.env.LINA_QA_CHROMIUM
		? { executablePath: process.env.LINA_QA_CHROMIUM }
		: {}),
});
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [];
const measurements = [];
page.on("pageerror", (error) => errors.push(error.message));
try {
	await page.goto(`${base}/?agent=lina`);
	await page.locator("#other-agents .agent-row").first().waitFor();
	await page.locator("#messages .message").first().waitFor();
	const palette = await page.evaluate(() => {
		const style = getComputedStyle(document.documentElement);
		return Object.fromEntries(
			["--surface-main", "--surface-sidebar", "--input-bg"].map((key) => [
				key,
				style.getPropertyValue(key).trim(),
			]),
		);
	});
	await page.screenshot({ path: join(output, "desktop.png") });
	// The user-provided Codex reference has the darkest reading surface, then sidebar,
	// then composer. Previous Lina implementation inverted the first two surfaces.
	assert.equal(
		palette["--surface-main"],
		"#181818",
		"reference: darkest reading surface",
	);
	assert.equal(
		palette["--surface-sidebar"],
		"#212121",
		"reference: raised navigation surface",
	);
	for (const width of [1440, 1024, 768, 390, 320]) {
		await page.setViewportSize({ width, height: width < 768 ? 844 : 900 });
		if (width < 768 && (await page.locator("#other-agents").isVisible()))
			await page
				.locator('#other-agents [data-agent-id="lina"] .agent-link')
				.click();
		await page.locator("#message").fill("다음 주 여행 준비를 함께 정리해줘.");
		const geometry = await page.evaluate(() => {
			const rect = (selector) => {
				const r = document.querySelector(selector).getBoundingClientRect();
				return {
					x: r.x,
					y: r.y,
					width: r.width,
					height: r.height,
					right: r.right,
					bottom: r.bottom,
				};
			};
			return {
				viewport: innerWidth,
				scrollWidth: document.documentElement.scrollWidth,
				composer: rect(".composer"),
				send: rect("#send"),
				attach: rect("#attach-file"),
				model: rect("#composer-model"),
				header: rect(".chat-header"),
				title: rect("#chat-agent-name"),
				menu: rect("#current-agent-settings"),
			};
		});
		measurements.push(geometry);
		assert.ok(
			geometry.scrollWidth <= width,
			`no horizontal page overflow at ${width}`,
		);
		assert.ok(
			Math.abs(geometry.send.width - geometry.send.height) < 1,
			"send has a circular icon target",
		);
		assert.ok(
			Math.abs(
				geometry.send.y +
					geometry.send.height / 2 -
					(geometry.attach.y + geometry.attach.height / 2),
			) < 1,
			"composer controls share a center line",
		);
		assert.ok(
			geometry.model.right <= geometry.send.x,
			"model control does not overlap send",
		);
		assert.ok(
			geometry.composer.bottom <= (width < 768 ? 844 : 900),
			"composer stays in viewport",
		);
		assert.equal(
			await page.locator("#attach-file svg").count(),
			1,
			"attachment has a real shared-size SVG icon",
		);
		if (width < 768) {
			assert.ok(
				geometry.send.width >= 44 && geometry.attach.width >= 44,
				"mobile action targets >=44px",
			);
			assert.ok(
				geometry.title.right <= geometry.menu.x,
				"title does not overlap header actions",
			);
		}
		await page.locator("#message").blur();
		await page.screenshot({ path: join(output, `conversation-${width}.png`) });
	}
	await page.locator("#open-sidebar").click();
	await page.locator("#mobile-settings").click();
	await page.locator("#settings-dialog[open]").waitFor();
	for (const width of [390, 320]) {
		await page.setViewportSize({ width, height: 844 });
		const tabs = await page
			.locator('.settings-navigation [role="tab"] span')
			.evaluateAll((nodes) =>
				nodes.map((node) => ({
					height: node.getBoundingClientRect().height,
					line: Number.parseFloat(getComputedStyle(node).lineHeight),
				})),
			);
		assert.ok(
			tabs.every((tab) => tab.height <= tab.line + 1),
			`settings tab labels stay on one line at ${width}`,
		);
		const modal = await page.locator("#settings-dialog").boundingBox();
		assert.ok(
			modal && modal.x === 0 && modal.width === width,
			"mobile settings use the full screen",
		);
	}
	await page.locator('[data-theme-choice="light"]').click();
	const surfaces = await page.evaluate(() => {
		const bg = (selector) =>
			getComputedStyle(document.querySelector(selector)).backgroundColor;
		return {
			reading: bg(".workspace"),
			composer: bg(".composer"),
			taskInput: bg(".task-composer"),
			taskBody: bg("#task-dialog"),
		};
	});
	assert.notEqual(
		surfaces.composer,
		surfaces.reading,
		"unfocused light composer remains distinguishable from reading surface",
	);
	assert.notEqual(
		surfaces.taskInput,
		surfaces.taskBody,
		"unfocused light task input remains distinguishable from its dialog",
	);
	assert.deepEqual(errors, []);
	console.log(
		"PASS: reference surface hierarchy, composer alignment, icon controls and responsive containment (5 viewports)",
	);
} finally {
	await writeFile(
		join(output, "geometry.json"),
		JSON.stringify({ measurements, errors }, null, 2),
	);
	await browser.close();
}
