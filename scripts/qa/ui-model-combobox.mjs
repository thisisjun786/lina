import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

// Bun builds the actual settings controller and React adapter; no provider calls.
const client = fileURLToPath(
	new URL("../../packages/lina-ui/client/", import.meta.url),
);
const out = process.env.LINA_QA_OUTPUT ?? "/tmp/lina-model-combobox";
const { chromium } = await import(
	process.env.LINA_QA_PLAYWRIGHT_MODULE ?? "playwright"
);
const fixture = `
import { createModelCombobox } from ${JSON.stringify(`${client}model-combobox.ts`)};
import { installModelSettings } from ${JSON.stringify(`${client}model-settings.ts`)};
const dialog = document.getElementById('settings-dialog');
for (const panel of dialog.querySelectorAll('[role="tabpanel"]')) panel.hidden = panel.id !== 'settings-panel-models';
window.saved = { revision: 0, profiles: [], roles: {}, agentRoles: {}, defaultProfileId: null };
const catalog = [
 { provider: 'local', id: 'glm-flash', name: 'GLM Flash', authenticated: true, reasoning: true },
 { provider: 'remote', id: 'vision', name: 'Vision', authenticated: true, reasoning: true, imageInput: true },
 { provider: 'hidden', id: 'hidden', name: 'Hidden', authenticated: false, reasoning: true },
 ...Array.from({ length: 35 }, (_, i) => ({ provider: 'local', id: 'model-' + i, name: 'Model ' + String(i).padStart(2, '0'), authenticated: true, reasoning: false }))
].map(item => ({ contextWindow: 64000, maxOutputTokens: 8000, ...item }));
window.settings = installModelSettings(dialog, createModelCombobox, document, async (path, method, body) => {
 if (method === 'PATCH') { window.saved = { ...body.settings, revision: body.revision + 1 }; return { settings: window.saved }; }
 if (method !== 'GET') throw Error('Unexpected request: ' + path);
 return { settings: window.saved, catalog, active: [] };
});
window.chosen = [];
window.items = [
 { value: '', label: '전역 모델 사용 · GLM Flash', inherited: true },
 { value: 'glm', label: 'GLM Flash', search: 'LOCAL glm-flash fast' },
 { value: 'vision', label: 'Vision', search: 'remote image' },
 ...Array.from({ length: 35 }, (_, i) => ({ value: 'extra-' + i, label: 'Extra ' + String(i).padStart(2, '0') }))
];
window.combo = createModelCombobox(document, 'qa-model', 'QA 모델', value => window.chosen.push(value));
window.combo.set(window.items, 'vision', 'Vision');
document.getElementById('model-settings').before(window.combo.root);
dialog.showModal();
await window.settings.open();
window.ready = true;
`;
const build = await Bun.build({
	entrypoints: [
		"model-combobox-fixture",
		`${client}styles.css`,
		`${client}theme-boot.ts`,
	],
	target: "browser",
	define: { "process.env.NODE_ENV": '"production"' },
	plugins: [
		{
			name: "model-combobox-fixture",
			setup(builder) {
				builder.onResolve({ filter: /^model-combobox-fixture$/ }, () => ({
					path: "fixture",
					namespace: "fixture",
				}));
				builder.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({
					loader: "js",
					contents: fixture,
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
	.replace('src="/app.js"', 'src="/model-combobox-fixture.js"')
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
await mkdir(out, { recursive: true });
const results = [];
const browser = await chromium.launch({
	headless: true,
	...(process.env.LINA_QA_CHROMIUM
		? { executablePath: process.env.LINA_QA_CHROMIUM }
		: {}),
});
async function expanded(input, value) {
	await input
		.page()
		.waitForFunction(
			({ id, value }) =>
				document.getElementById(id).getAttribute("aria-expanded") ===
				String(value),
			{ id: await input.getAttribute("id"), value },
		);
}
async function contained(page) {
	await page.waitForFunction(() => {
		const popup = document.querySelector(".model-combobox-popup");
		if (!popup) return false;
		const r = popup.getBoundingClientRect();
		const clip = popup.closest("dialog").getBoundingClientRect();
		return (
			r.width > 0 &&
			r.height > 0 &&
			r.left >= Math.max(0, clip.left) &&
			r.right <= Math.min(innerWidth, clip.right) &&
			r.top >= Math.max(0, clip.top) &&
			r.bottom <= Math.min(innerHeight, clip.bottom)
		);
	});
}
async function check(name, run, viewport = { width: 1280, height: 577 }) {
	if (process.env.LINA_QA_CASE && !name.includes(process.env.LINA_QA_CASE))
		return;
	const context = await browser.newContext({ viewport });
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
try {
	await check(
		"programmatic set(disabled) closes popup and preserves label and node",
		async (page) => {
			const input = page.getByRole("combobox", {
				name: "QA 모델",
				exact: true,
			});
			await input.click();
			await expanded(input, true);
			await page.evaluate(() => {
				window.originalInput = window.combo.input;
				window.combo.set(window.items, "gone", "연결 확인 필요", true);
			});
			await expanded(input, false);
			assert.equal(await input.isDisabled(), true);
			assert.equal(await input.inputValue(), "연결 확인 필요");
			assert.equal(await input.getAttribute("title"), "연결 확인 필요");
			assert.equal(
				await page.evaluate(() => window.originalInput === window.combo.input),
				true,
			);
			await page.evaluate(() => window.combo.disable(false));
			await input.click();
			await expanded(input, true);
			await page.evaluate(() => window.combo.disable(true));
			await expanded(input, false);
			assert.deepEqual(await page.evaluate(() => window.chosen), []);
		},
	);
	await check(
		"aliases, inherited ordering, empty status and keyboard selection",
		async (page) => {
			const input = page.getByRole("combobox", {
				name: "QA 모델",
				exact: true,
			});
			await input.click();
			await expanded(input, true);
			assert.equal(
				await page
					.getByRole("listbox")
					.getByRole("option")
					.first()
					.textContent(),
				"전역 모델 사용 · GLM Flash",
			);
			await input.fill("GLM");
			await page.waitForFunction(
				() => document.querySelectorAll('[role="option"]').length === 2,
			);
			assert.equal(
				await page
					.getByRole("listbox")
					.getByRole("option")
					.first()
					.textContent(),
				"GLM Flash",
			);
			await input.fill("  FAST   local ");
			await page.waitForFunction(
				() => document.querySelectorAll('[role="option"]').length === 1,
			);
			await input.press("ArrowDown");
			await input.press("Enter");
			await expanded(input, false);
			assert.deepEqual(await page.evaluate(() => window.chosen), ["glm"]);
			assert.equal(await input.inputValue(), "GLM Flash");
			await input.click();
			await expanded(input, true);
			assert.equal(
				await page
					.getByRole("listbox")
					.getByRole("option", { name: "GLM Flash", exact: true })
					.getAttribute("aria-selected"),
				"true",
			);
			await input.fill("missing-model");
			await page.getByText("검색 결과가 없습니다.", { exact: true }).waitFor();
			assert.equal(
				await page.locator('[role="listbox"] [role="status"]').count(),
				0,
			);
			await input.press("Enter");
			assert.deepEqual(await page.evaluate(() => window.chosen), ["glm"]);
			// Base UI dismisses on Enter without a highlighted option; reopen before Escape.
			await input.click();
			await expanded(input, true);
			await input.fill("missing-model");
			await page.getByText("검색 결과가 없습니다.", { exact: true }).waitFor();
			await input.press("Escape");
			assert.equal(
				await page.locator("#settings-dialog").evaluate((node) => node.open),
				true,
				"first Escape only closes the popup",
			);
			await expanded(input, false);
			assert.equal(await input.inputValue(), "GLM Flash");
			assert.equal(
				await page.locator("#settings-dialog").evaluate((node) => node.open),
				true,
			);
			await input.press("Escape");
			await page.waitForFunction(
				() => !document.getElementById("settings-dialog").open,
			);
		},
	);
	await check(
		"keyboard opening, inherited selection and updates during search",
		async (page) => {
			const input = page.locator("#qa-model-input");
			await input.focus();
			await input.press("ArrowDown");
			await expanded(input, true);
			await input.fill("extra");
			await input.press("ArrowUp");
			await input.press("Enter");
			await expanded(input, false);
			assert.deepEqual(await page.evaluate(() => window.chosen), ["extra-34"]);
			await input.click();
			await input.fill("");
			await page.getByRole("listbox").getByRole("option").first().click();
			assert.deepEqual(await page.evaluate(() => window.chosen), [
				"extra-34",
				"",
			]);
			await input.click();
			await input.fill("GLM");
			await page.evaluate(() => {
				window.combo.input.setAttribute(
					"aria-describedby",
					"model-settings-status",
				);
				window.combo.set(window.items, "vision", "Updated Vision");
			});
			assert.equal(await input.inputValue(), "GLM");
			assert.equal(await input.getAttribute("title"), "Updated Vision");
			await page.evaluate(() => window.combo.close());
			assert.equal(await input.inputValue(), "Updated Vision");
			assert.equal(
				await input.getAttribute("aria-describedby"),
				"model-settings-status",
			);
			assert.deepEqual(await page.evaluate(() => window.chosen), [
				"extra-34",
				"",
			]);
		},
	);
	await check(
		"pointer selection, tab/outside dismissal and explicit close",
		async (page) => {
			const input = page.getByRole("combobox", {
				name: "QA 모델",
				exact: true,
			});
			await input.click();
			await expanded(input, true);
			await page
				.getByRole("listbox")
				.getByRole("option", { name: "GLM Flash", exact: true })
				.click();
			await expanded(input, false);
			assert.deepEqual(await page.evaluate(() => window.chosen), ["glm"]);
			assert.equal(
				await input.evaluate((node) => document.activeElement === node),
				true,
			);
			await input.click();
			await expanded(input, true);
			await input.press("Tab");
			await expanded(input, false);
			assert.equal(
				await input.evaluate((node) => document.activeElement === node),
				false,
			);
			await input.click();
			await expanded(input, true);
			await page.locator("#settings-heading").click();
			await expanded(input, false);
			await input.click();
			await expanded(input, true);
			await page.evaluate(() => window.combo.close());
			await expanded(input, false);
		},
	);
	for (const viewport of [
		{ width: 1280, height: 577 },
		{ width: 390, height: 844 },
	]) {
		await check(
			`dialog top layer and viewport collision ${viewport.width}`,
			async (page) => {
				const input = page.locator("#model-vision-input");
				await input.click();
				await expanded(input, true);
				const list = page.getByRole("listbox");
				await list.waitFor();
				assert.equal(
					await list.evaluate((node) => node.closest("dialog")?.id),
					"settings-dialog",
				);
				assert.equal(
					await list.evaluate(
						(node) => node.closest(".settings-content") === null,
					),
					true,
					"popup escapes the settings scrollport",
				);
				const option = page
					.getByRole("listbox")
					.getByRole("option", { name: "Vision · remote", exact: true });
				await option.scrollIntoViewIfNeeded();
				assert.equal(
					await option.evaluate((node) => {
						const r = node.getBoundingClientRect();
						const hit = document.elementFromPoint(
							r.x + r.width / 2,
							r.y + r.height / 2,
						);
						return node === hit || node.contains(hit);
					}),
					true,
					"option is hit-testable in native dialog top layer",
				);
				await option.click();
				await expanded(input, false);
				const dense = page.locator("#model-recall-input");
				await dense.click();
				await expanded(dense, true);
				await contained(page);
				await page
					.getByRole("listbox")
					.getByRole("option", { name: "Model 34 · local", exact: true })
					.scrollIntoViewIfNeeded();
				await page
					.getByRole("listbox")
					.getByRole("option", { name: "Model 34 · local", exact: true })
					.click();
				await expanded(dense, false);
				await dense.click();
				await expanded(dense, true);
				await contained(page);
				await page
					.getByRole("listbox")
					.getByRole("option", { name: "Model 34 · local", exact: true })
					.scrollIntoViewIfNeeded();
				await page.screenshot({ path: `${out}/dialog-${viewport.width}.png` });
			},
			viewport,
		);
	}
	await check(
		"open popup follows resize and settings scrolling",
		async (page) => {
			const input = page.locator("#model-recall-input");
			await input.click();
			await expanded(input, true);
			await contained(page);
			await page.setViewportSize({ width: 1024, height: 650 });
			await contained(page);
			await page.locator(".settings-content").evaluate((node) => {
				node.scrollTop -= 60;
			});
			await page.waitForFunction(() => {
				const input = document
					.getElementById("model-recall-input")
					.getBoundingClientRect();
				const positioner = document.querySelector(".model-combobox-positioner");
				const popup = positioner.getBoundingClientRect();
				const gap =
					positioner.dataset.side === "top"
						? input.top - popup.bottom
						: popup.top - input.bottom;
				return Math.abs(gap - 5) <= 1 && Math.abs(input.left - popup.left) <= 1;
			});
			await contained(page);
			await page.screenshot({ path: `${out}/resized.png` });
		},
	);
	await check(
		"bottom-edge anchor flips above within the native dialog",
		async (page) => {
			await page.evaluate(() => {
				const dialog = document.getElementById("settings-dialog");
				dialog.append(window.combo.root);
				Object.assign(window.combo.root.style, {
					position: "absolute",
					bottom: "16px",
					left: "24px",
					width: "260px",
				});
			});
			const input = page.locator("#qa-model-input");
			await input.click();
			await expanded(input, true);
			await page.waitForFunction(
				() =>
					document.querySelector(".model-combobox-positioner")?.dataset.side ===
					"top",
			);
			await contained(page);
			const boxes = await page.evaluate(() => ({
				inputTop: document
					.getElementById("qa-model-input")
					.getBoundingClientRect().top,
				popupBottom: document
					.querySelector(".model-combobox-popup")
					.getBoundingClientRect().bottom,
			}));
			assert.ok(boxes.popupBottom < boxes.inputTop);
			await page.screenshot({ path: `${out}/flipped.png` });
		},
	);
	await check(
		"real model settings selection saves correct roles and filters providers",
		async (page) => {
			const input = page.locator("#model-default-input");
			await input.click();
			await input.fill("glm-flash");
			await page
				.getByRole("listbox")
				.getByRole("option", { name: "GLM Flash · local", exact: true })
				.click();
			const summary = page.locator("#model-summary-input");
			await summary.click();
			await summary.fill("GLM");
			assert.equal(
				await page
					.getByRole("listbox")
					.getByRole("option")
					.first()
					.textContent(),
				"GLM Flash · local",
			);
			await page
				.getByRole("listbox")
				.getByRole("option", { name: "GLM Flash · local", exact: true })
				.click();
			await page.locator("#model-save").click();
			await page.waitForFunction(() => window.saved.revision === 1);
			assert.equal(
				await page.evaluate(
					() =>
						window.saved.profiles.find(
							(p) => p.id === window.saved.roles.summary,
						).model,
				),
				"glm-flash",
			);
			await input.click();
			assert.equal(
				await page
					.getByRole("listbox")
					.getByRole("option", { name: "Hidden · hidden", exact: true })
					.count(),
				0,
			);
			await input.press("Escape");
			await page.locator("#model-vision-input").click();
			assert.equal(
				await page
					.getByRole("listbox")
					.getByRole("option", { name: "GLM Flash · local", exact: true })
					.count(),
				0,
			);
			assert.equal(
				await page
					.getByRole("listbox")
					.getByRole("option", { name: "Vision · remote", exact: true })
					.count(),
				1,
			);
		},
	);
} finally {
	await browser.close();
	await server.stop(true);
	await writeFile(`${out}/results.json`, JSON.stringify(results, null, 2));
}
console.log(JSON.stringify(results, null, 2));
if (results.some((result) => !result.pass)) process.exitCode = 1;
