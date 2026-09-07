import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { chromium } = await import(
	process.env.LINA_QA_PLAYWRIGHT_MODULE ?? "playwright"
);
const profile = await mkdtemp(join(tmpdir(), "lina-task-browser-"));
const options = {
	headless: true,
	viewport: { width: 1440, height: 900 },
	...(process.env.LINA_QA_CHROMIUM
		? { executablePath: process.env.LINA_QA_CHROMIUM }
		: {}),
};
const url =
	(process.env.LINA_QA_URL ?? "http://127.0.0.1:18140") +
	"/?agent=lina&task=task-1";
let context;
try {
	context = await chromium.launchPersistentContext(profile, options);
	let page = await context.newPage();
	await page.goto(url);
	await page.waitForFunction(() =>
		document.querySelector("#task-heading").textContent.includes("로그인 오류"),
	);
	await page.locator("#task-input").fill("브라우저를 닫아도 남는 작업 입력");
	await page.locator("#task-owner").selectOption("kai");
	await page.locator("#task-dialog [data-close]").first().click();
	await page.locator("#task-scope").selectOption("all");
	await context.close();
	context = undefined;
	context = await chromium.launchPersistentContext(profile, options);
	page = await context.newPage();
	await page.goto(url);
	await page.waitForFunction(() =>
		document.querySelector("#task-heading").textContent.includes("로그인 오류"),
	);
	assert.equal(
		await page.locator("#task-input").inputValue(),
		"브라우저를 닫아도 남는 작업 입력",
	);
	assert.equal(await page.locator("#task-owner").inputValue(), "kai");
	await page.locator("#task-dialog [data-close]").first().click();
	assert.equal(await page.locator("#task-scope").inputValue(), "all");
	const result = {
		pass: true,
		independentBrowserProcesses: 2,
		taskInputRestored: true,
		ownerDraftRestored: true,
		allOwnerFilterRestored: true,
		serverMutation: false,
	};
	await writeFile(
		join(
			process.env.LINA_QA_OUTPUT ?? "/tmp/lina-ui-desktop-evidence",
			"task-restart.json",
		),
		JSON.stringify(result, null, 2),
	);
	console.log(JSON.stringify(result));
} finally {
	await context?.close();
	await rm(profile, { recursive: true, force: true });
}
