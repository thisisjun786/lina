// Isolated renderer smoke. Run with Bun and an installed Playwright module.
import assert from "node:assert/strict";

const { chromium } = await import(
	process.env.LINA_PLAYWRIGHT_MODULE ?? "playwright"
);
const client = new URL("../../lina-ui/client/", import.meta.url);
const source = await Bun.file(new URL("index.html", client)).text();
const nav = source.match(
	/<nav\b[^>]*\bid="task-pane"[^>]*>[\s\S]*?<\/nav>/,
)?.[0];
const detail = source.match(
	/<dialog\b[^>]*\bid="task-dialog"[^>]*>[\s\S]*?<\/dialog>/,
)?.[0];
assert.ok(nav && detail, "task pane and detail markup exist");
const built = await Bun.build({
	entrypoints: [new URL("task-view.ts", client).pathname],
	target: "browser",
});
assert.ok(built.success, String(built.logs));
const css = (
	await Promise.all(
		[
			"tokens.css",
			"base.css",
			"sidebar.css",
			"chat.css",
			"composer.css",
			"responsive.css",
			"settings.css",
			"tasks.css",
		].map((name) => Bun.file(new URL(name, client)).text()),
	)
).join("\n");
const bootstrap = `
import { installTasks } from '/task-view.js';
const tasks = ['lina', 'kai'].map((ownerAgentId, index) => ({
 id: 'task-' + (index + 1), threadId: 'native-' + (index + 1), ownerAgentId,
 title: index ? '카이의 로그인 오류 수정' : '리나의 긴 한글 작업 제목과 회귀 확인',
 cwd: '/tmp/work', status: 'inProgress', revision: 3, model: 'fixture',
 updatedAt: '2026-09-07T12:00:00Z', pendingApprovals: []
}));
window.taskView = installTasks({ownerAgentId: 'lina', scheduler: () => () => {},
 request: async (path) => {
  if (path === '/api/agents') return {agents: [{id:'lina', name:'리나'}, {id:'kai', name:'카이'}]};
  if (path === '/api/tasks') return {tasks};
  const task = tasks.find(task => path === '/api/tasks/' + task.id);
  if (!task) throw Error(path);
  return {task, thread: null};
 }
});
await window.taskView.showList();
document.body.dataset.ready = 'true';
`;
const server = Bun.serve({
	hostname: "127.0.0.1",
	port: 0,
	fetch(request) {
		const path = new URL(request.url).pathname;
		if (path === "/task-view.js") return new Response(built.outputs[0]);
		if (path === "/bootstrap.js")
			return new Response(bootstrap, {
				headers: { "Content-Type": "text/javascript" },
			});
		return new Response(
			`<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style></head><body><aside class="sidebar" style="width:min(304px,100%);padding:12px">${nav}</aside><aside id="task-column" style="width:min(280px,100%);padding:12px"></aside>${detail}<script type="module" src="/bootstrap.js"></script></body></html>`,
			{ headers: { "Content-Type": "text/html" } },
		);
	},
});
const browser = await chromium.launch({
	headless: true,
	...(process.env.LINA_CHROMIUM_PATH
		? { executablePath: process.env.LINA_CHROMIUM_PATH }
		: {}),
	args: ["--no-sandbox"],
});
const errors = [];
const captures = [];
try {
	const page = await browser.newPage({
		viewport: { width: 1440, height: 900 },
	});
	page.on("pageerror", (error) => errors.push(error.message));
	await page.goto(server.url.href);
	await page.waitForFunction(() => document.body.dataset.ready === "true");
	assert.equal(await page.locator("#task-list button").count(), 1);
	await page.locator("#task-scope").selectOption("all");
	await page.getByRole("button", { name: /카이의 로그인/ }).waitFor();
	await page.evaluate(() => {
		document
			.querySelector("#task-column")
			.append(document.querySelector("#task-pane"));
		document.documentElement.dataset.sidebarCollapsed = "true";
	});
	assert.equal(await page.locator("#task-list").isVisible(), true);
	assert.equal(await page.locator("#add-task").isVisible(), true);
	assert.equal(await page.locator("#task-reload").isVisible(), true);
	await page.getByRole("button", { name: /리나의 긴 한글/ }).click();
	await page.waitForFunction(
		() => !document.querySelector("#task-interrupt").disabled,
	);
	await page.locator("#task-input").fill("리나 작업에만 남길 초안");
	assert.equal(
		await page.locator("#task-open-codex").getAttribute("href"),
		"codex://threads/native-1",
	);
	await page.locator("#task-close").click();
	await page.locator("#task-dialog").waitFor({ state: "hidden" });
	await page.getByRole("button", { name: /카이의 로그인/ }).click();
	await page.waitForFunction(
		() => !document.querySelector("#task-interrupt").disabled,
	);
	assert.equal(await page.locator("#task-input").inputValue(), "");
	await page.locator("#task-close").click();
	await page.locator("#task-dialog").waitFor({ state: "hidden" });
	if (process.env.TASK_UI_CAPTURE)
		captures.push({
			name: "desktop-list",
			data: (await page.screenshot()).toString("base64"),
		});
	await page.setViewportSize({ width: 390, height: 844 });
	await page.getByRole("button", { name: /리나의 긴 한글/ }).click();
	await page.waitForFunction(
		() => !document.querySelector("#task-interrupt").disabled,
	);
	assert.equal(
		await page.locator("#task-input").inputValue(),
		"리나 작업에만 남길 초안",
	);
	assert.equal(
		await page.getByRole("button", { name: "담당 넘기기" }).isVisible(),
		true,
	);
	const bounds = await page.locator("#task-dialog").boundingBox();
	assert.equal(bounds.width, 390);
	assert.equal(bounds.height, 844);
	if (process.env.TASK_UI_CAPTURE)
		captures.push({
			name: "mobile-detail",
			data: (await page.screenshot()).toString("base64"),
		});
	await page.keyboard.press("Escape");
	await page.locator("#task-dialog").waitFor({ state: "hidden" });
	assert.equal(await page.locator("#task-scope").inputValue(), "all");
	assert.equal(await page.locator("#task-list button").count(), 2);
	assert.deepEqual(errors, []);
	console.log(
		JSON.stringify({
			result: "pass",
			viewports: ["1440x900", "390x844"],
			errors,
			captures,
		}),
	);
} finally {
	await browser.close();
	await server.stop(true);
}
