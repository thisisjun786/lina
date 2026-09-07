import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

// Bun + an installed Playwright; isolated component host, no model or user data.
const { chromium } = await import(
	process.env.LINA_QA_PLAYWRIGHT_MODULE ?? "playwright"
);
const root = fileURLToPath(new URL("../../", import.meta.url));
const output = process.env.LINA_QA_OUTPUT ?? "/tmp/lina-agent-list-evidence";
await mkdir(output, { recursive: true });
const bundle = await Bun.build({
	entrypoints: ["agent-list-qa"],
	target: "browser",
	define: { "process.env.NODE_ENV": '"production"' },
	plugins: [
		{
			name: "agent-list-fixture",
			setup(build) {
				build.onResolve({ filter: /^agent-list-qa$/ }, () => ({
					path: "agent-list-qa",
					namespace: "fixture",
				}));
				build.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({
					loader: "ts",
					resolveDir: root,
					contents: `
import { createAgentListView } from ${JSON.stringify(`${root}packages/lina-ui/client/agent-list.ts`)};
import { AgentListModel } from ${JSON.stringify(`${root}packages/lina-client/src/agent-list.ts`)};
import ${JSON.stringify(`${root}packages/lina-ui/client/styles.css`)};
const model = new AgentListModel("lina");
const profiles = [
 { id: "lina", name: "Lina", role: "개인 에이전트", avatarId: null },
 { id: "writer", name: "긴 이름 작가", role: "글쓰기", avatarId: null },
 { id: "research", name: "Research", role: "자료 조사", avatarId: null },
];
const calls = { selected: [], menus: [], retries: 0 };
const render = createAgentListView(model, document.querySelector("#other-agents"), document.querySelector("#agent-list-status"), {
 select(id) { calls.selected.push(id); },
 menu(id, opener) { calls.menus.push({ id, connected: opener.isConnected, label: opener.getAttribute("aria-label"), className: opener.className }); },
 retry() { calls.retries++; },
});
const filter = document.querySelector("#agent-filter");
filter.addEventListener("input", () => { model.setFilter(filter.value); render(); });
render();
window.fixture = { model, profiles, calls, render };
`,
				}));
			},
		},
	],
});
assert.ok(bundle.success, bundle.logs.join("\n"));
const assets = new Map(
	bundle.outputs.map((asset) => [asset.path.replace(/^\.\//, "/"), asset]),
);
const server = Bun.serve({
	hostname: "127.0.0.1",
	port: 0,
	fetch(request) {
		const path = new URL(request.url).pathname;
		if (path === "/")
			return new Response(
				`<!doctype html><html lang="ko" data-screen="agents"><head><meta charset="utf-8"><link rel="stylesheet" href="/agent-list-qa.css"></head><body><aside id="sidebar" class="sidebar"><div class="sidebar-content"><nav id="agent-pane" aria-label="에이전트"><label for="agent-filter">이름과 역할로 찾기</label><input id="agent-filter"><p id="agent-list-status"></p><div id="other-agents"></div></nav></div></aside><script type="module" src="/agent-list-qa.js"></script></body></html>`,
				{ headers: { "content-type": "text/html" } },
			);
		const asset = assets.get(path);
		return asset
			? new Response(asset)
			: new Response("Not found", { status: 404 });
	},
});
const browser = await chromium.launch({
	headless: true,
	...(process.env.LINA_QA_CHROMIUM
		? { executablePath: process.env.LINA_QA_CHROMIUM }
		: {}),
});
const context = await browser.newContext({
	viewport: { width: 390, height: 844 },
	hasTouch: true,
});
await context.tracing.start({ screenshots: true, snapshots: true });
const page = await context.newPage();
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
const results = [];
const row = (id) => page.locator(`[data-agent-id="${id}"] .agent-link`);
async function reset() {
	await page.goto(server.url.href);
	await page.waitForFunction(() => !!window.fixture);
	await page.evaluate(() => {
		fixture.model.replace(fixture.profiles);
		fixture.render();
	});
}
async function check(name, run) {
	try {
		await reset();
		await run();
		results.push({ name, pass: true });
	} catch (error) {
		results.push({ name, pass: false, error: String(error) });
		await page.screenshot({ path: `${output}/failure-${results.length}.png` });
	}
}
const touch = {
	pointerType: "touch",
	pointerId: 1,
	isPrimary: true,
	clientX: 25,
	clientY: 25,
};
try {
	await check("filtering a pressed row cancels its menu", async () => {
		await page.clock.install();
		await row("writer").dispatchEvent("pointerdown", touch);
		await page.locator("#agent-filter").fill("Research");
		await page.clock.runFor(600);
		assert.deepEqual(await page.evaluate(() => fixture.calls.menus), []);
	});
	await check("scroll cancels a pending touch menu", async () => {
		await page.clock.install();
		await row("writer").dispatchEvent("pointerdown", touch);
		await page.locator(".sidebar-content").dispatchEvent("scroll");
		await page.clock.runFor(600);
		assert.deepEqual(await page.evaluate(() => fixture.calls.menus), []);
	});
	await check(
		"keyboard, selection, menu openers and stable retained rows",
		async () => {
			await row("lina").focus();
			await page.keyboard.press("ArrowDown");
			assert.equal(
				await row("writer").evaluate((node) => node === document.activeElement),
				true,
			);
			await page.keyboard.press("End");
			assert.equal(
				await row("research").evaluate(
					(node) => node === document.activeElement,
				),
				true,
			);
			await page.keyboard.press("ArrowUp");
			await page.keyboard.press("Home");
			await page.keyboard.press("Enter");
			assert.deepEqual(await page.evaluate(() => fixture.calls.selected), [
				"lina",
			]);
			await page.keyboard.press("Shift+F10");
			await row("writer").dispatchEvent("contextmenu");
			await page.locator('[data-agent-id="research"] .agent-more').click();
			assert.deepEqual(
				await page.evaluate(() =>
					fixture.calls.menus.map(({ id, connected }) => ({ id, connected })),
				),
				[
					{ id: "lina", connected: true },
					{ id: "writer", connected: true },
					{ id: "research", connected: true },
				],
			);
			assert.ok(
				await page.evaluate(() =>
					fixture.calls.menus.every(
						(call) =>
							call.className.includes("agent-more") &&
							call.label.endsWith(" 메뉴"),
					),
				),
			);
			await row("writer").focus();
			const stable = await row("writer").elementHandle();
			await page.evaluate(() => {
				fixture.model.replace([...fixture.profiles].reverse());
				fixture.model.setCurrent("writer");
				fixture.model.setDraft("writer", "업데이트된 초안");
				fixture.render();
			});
			assert.equal(
				await stable.evaluate(
					(node) =>
						node ===
							document.querySelector('[data-agent-id="writer"] .agent-link') &&
						node === document.activeElement,
				),
				true,
			);
			await page.locator("#agent-filter").fill("글쓰기");
			assert.equal(await row("writer").isVisible(), true);
			assert.equal(await row("lina").isVisible(), false);
		},
	);
	await check("long press, move, up, cancel and leave", async () => {
		await page.clock.install();
		for (const type of [
			"pointermove",
			"pointerup",
			"pointercancel",
			"pointerleave",
		]) {
			await row("writer").dispatchEvent("pointerdown", touch);
			// Browsers emit out before leave; React derives onPointerLeave from out.
			if (type === "pointerleave")
				await row("writer").dispatchEvent("pointerout", touch);
			await row("writer").dispatchEvent(type, {
				...touch,
				clientY: type === "pointermove" ? 50 : 25,
			});
			await page.clock.runFor(600);
			assert.deepEqual(
				await page.evaluate(() => fixture.calls.menus),
				[],
				type,
			);
		}
		assert.deepEqual(await page.evaluate(() => fixture.calls.menus), []);
		await row("writer").dispatchEvent("pointerdown", touch);
		await page.clock.runFor(550);
		await row("writer").dispatchEvent("pointerup", touch);
		await row("writer").dispatchEvent("click", { detail: 1 });
		assert.deepEqual(
			await page.evaluate(() => fixture.calls.menus.map((call) => call.id)),
			["writer"],
		);
		assert.deepEqual(await page.evaluate(() => fixture.calls.selected), []);
		await row("writer").click();
		assert.deepEqual(await page.evaluate(() => fixture.calls.selected), [
			"writer",
		]);
	});
	await check(
		"status, row details, unread and confirmation precedence",
		async () => {
			await page.evaluate(() => {
				fixture.model.updateSummary({
					agentId: "writer",
					available: true,
					sessionId: "session",
					revision: 1,
					latestMessage: {
						entryId: "a",
						seq: 1,
						role: "assistant",
						text: "저장된 답변",
						timestamp: "2026-08-05T12:00:00Z",
					},
					confirmationCount: 0,
					running: true,
				});
				fixture.render();
			});
			const writer = page.locator('[data-agent-id="writer"]');
			assert.equal(
				await writer.locator("strong").getAttribute("title"),
				"긴 이름 작가",
			);
			assert.equal(
				await writer.locator("small").getAttribute("title"),
				"저장된 답변",
			);
			assert.equal(
				await writer.locator("time").getAttribute("datetime"),
				"2026-08-05T12:00:00Z",
			);
			assert.equal(await writer.locator("time").isVisible(), true);
			assert.equal(await writer.locator(".agent-working").isVisible(), true);
			assert.equal(
				await row("writer").getAttribute("aria-label"),
				"긴 이름 작가 · 글쓰기 · 저장된 답변 · 작업 중",
			);
			await page.evaluate(() => {
				fixture.model.markVisible("writer", "session", 1);
				const summary = fixture.model.summary("writer");
				fixture.model.updateSummary({
					...summary,
					revision: 2,
					latestMessage: { ...summary.latestMessage, seq: 2 },
					confirmationCount: 2,
				});
				fixture.model.summariesFailed();
				fixture.render();
			});
			assert.equal(
				await writer.locator("small").textContent(),
				"확인 필요 · 2건",
			);
			assert.equal(await writer.locator(".agent-unread").isVisible(), true);
			assert.equal(await writer.locator(".agent-working").isVisible(), false);
			assert.ok(
				(await writer.getAttribute("class")).includes("needs-confirmation"),
			);
			assert.equal(
				await row("writer").getAttribute("aria-label"),
				"긴 이름 작가 · 글쓰기 · 확인 필요 · 2건 · 읽지 않은 메시지 · 요약 새로 고침 실패 · 작업 중",
			);
			const status = page.locator("#agent-list-status");
			assert.ok(
				(await status.textContent()).includes(
					"일부 대화 요약을 새로 불러오지 못했어요.",
				),
			);
			await status.getByRole("button", { name: "다시 시도" }).click();
			assert.equal(await page.evaluate(() => fixture.calls.retries), 1);
			await page.screenshot({ path: `${output}/mobile-states.png` });
			await page.setViewportSize({ width: 1440, height: 900 });
			await page.screenshot({ path: `${output}/desktop-states.png` });
			await page.evaluate(() => {
				fixture.model.fail();
				fixture.render();
			});
			assert.ok(
				(await status.textContent()).includes(
					"에이전트 목록을 불러오지 못했어요.",
				),
			);
			await page.evaluate(() => {
				fixture.model.status = "loading";
				fixture.render();
			});
			assert.equal(
				await page.locator("#other-agents").getAttribute("aria-busy"),
				"true",
			);
			assert.ok(
				(await status.textContent()).includes("에이전트를 불러오는 중…"),
			);
			await page.evaluate(() => {
				fixture.model.replace([]);
				fixture.render();
			});
			assert.ok(
				(await status.textContent()).includes("아직 에이전트가 없어요."),
			);
			await page.locator("#agent-filter").fill("없음");
			assert.ok(
				(await status.textContent()).includes(
					"이름이나 역할이 일치하는 에이전트가 없어요.",
				),
			);
			assert.equal(await status.getAttribute("role"), "status");
			assert.equal(await status.getAttribute("aria-live"), "polite");
		},
	);
	await check(
		"avatar source changes, load failure and Unicode fallback",
		async () => {
			const avatar = page.locator('[data-agent-id="writer"] .avatar');
			assert.equal(await avatar.textContent(), "긴");
			await page.route("**/api/avatars/**", (route) =>
				route.fulfill({
					contentType: "image/svg+xml",
					body: route.request().url().endsWith("valid%2Fimage")
						? '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"><rect width="40" height="40" fill="blue"/></svg>'
						: "invalid image",
				}),
			);
			const updateAvatar = async (avatarId, name = "긴 이름 작가") =>
				page.evaluate(
					({ avatarId, name }) => {
						fixture.model.replace(
							fixture.profiles.map((profile) =>
								profile.id === "writer"
									? { ...profile, avatarId, name }
									: profile,
							),
						);
						fixture.render();
					},
					{ avatarId, name },
				);
			await updateAvatar("valid/image");
			await avatar.locator("img").waitFor({ state: "visible" });
			assert.ok(
				await avatar
					.locator("img")
					.evaluate((node) => node.complete && node.naturalWidth > 0),
			);
			assert.equal(await avatar.textContent(), "");
			await updateAvatar("broken");
			await avatar.locator("img").waitFor({ state: "detached" });
			await page.waitForFunction(
				() =>
					document.querySelector('[data-agent-id="writer"] .avatar')
						.textContent === "긴",
			);
			await updateAvatar(null, "  𠮷田  ");
			assert.equal(await avatar.textContent(), "𠮷");
			assert.equal(await avatar.getAttribute("aria-hidden"), "true");
			await updateAvatar(null, " ");
			assert.equal(await avatar.textContent(), "?");
			await updateAvatar("valid/image");
			await avatar.locator("img").waitFor({ state: "visible" });
		},
	);
	await check(
		"navigation notice recovers through the next normal render",
		async () => {
			const status = page.locator("#agent-list-status");
			await page.evaluate(() =>
				fixture.render.notice(
					"대화를 열지 못했어요. 에이전트를 다시 선택해주세요.",
				),
			);
			assert.equal(
				await status.locator("span").textContent(),
				"대화를 열지 못했어요. 에이전트를 다시 선택해주세요.",
			);
			assert.equal(await status.isVisible(), true);
			assert.equal(
				await status.getByRole("button", { name: "다시 시도" }).isVisible(),
				false,
			);
			await row("writer").click();
			await page.evaluate(() => {
				fixture.model.setCurrent("writer");
				fixture.render();
			});
			assert.equal(await status.isVisible(), false);
			assert.equal(await row("writer").getAttribute("aria-current"), "true");
			await page.evaluate(() => {
				fixture.render.notice("선택을 다시 확인해주세요.");
				fixture.model.fail();
				fixture.render();
			});
			assert.ok(
				(await status.textContent()).includes(
					"에이전트 목록을 불러오지 못했어요.",
				),
			);
			await status.getByRole("button", { name: "다시 시도" }).click();
			assert.equal(await page.evaluate(() => fixture.calls.retries), 1);
		},
	);
	assert.deepEqual(errors, []);
} finally {
	await context.tracing.stop({ path: `${output}/trace.zip` });
	await browser.close();
	await server.stop(true);
	await writeFile(
		`${output}/results.json`,
		JSON.stringify({ results, errors }, null, 2),
	);
}
console.log(JSON.stringify({ results, errors }, null, 2));
if (results.some((result) => !result.pass)) process.exitCode = 1;
