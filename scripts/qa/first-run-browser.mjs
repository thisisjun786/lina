// Full UI flow on an isolated intro-live.ts --serve server (no installed user data).
import assert from "node:assert/strict";
import fs from "node:fs";

const { chromium } = await import(
	process.env.LINA_PLAYWRIGHT_MODULE ?? "playwright"
);
const { root, base } = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
assert.match(root, /^\/tmp\/lina-onboarding-live-[a-zA-Z0-9]+$/);
assert.match(base, /^http:\/\/127\.0\.0\.1:[0-9]+$/);
const browser = await chromium.launch({
	...(process.env.LINA_CHROMIUM_PATH
		? { executablePath: process.env.LINA_CHROMIUM_PATH }
		: {}),
	headless: true,
	args: ["--no-sandbox"],
});
const evidence = {
	root,
	base,
	capturedAt: new Date().toISOString(),
	steps: [],
	answers: [],
	views: [],
	errors: [],
};
try {
	const page = await browser.newPage({
		viewport: { width: 1440, height: 900 },
	});
	page.on("pageerror", (e) => evidence.errors.push(e.message));
	const snap = () =>
		page.evaluate(async () => (await fetch("/api/agents/lina/intro")).json());
	const settled = () =>
		page.waitForFunction(
			() =>
				document.querySelector("#intro-stop")?.hidden &&
				document.querySelector("#messages .message.assistant"),
			null,
			{ timeout: 85000 },
		);
	const capture = async (name) => {
		if (await page.locator("body.intro-active").count()) {
			for (const id of [
				"sidebar",
				"open-sidebar",
				"sidebar-resizer",
				"sidebar-drawer",
			])
				assert.equal(await page.locator(`#${id}`).isVisible(), false);
			assert.equal(
				await page.getByText("평소 대화로", { exact: true }).count(),
				0,
			);
			assert.equal(await page.locator("#chat-agent-name").innerText(), "리나");
		}
		assert.equal(
			await page
				.locator("#open-onboarding, .intro-entry-link, #open-agent-onboarding")
				.count(),
			0,
		);
		const view = await page.evaluate(() => ({
			viewport: { width: innerWidth, height: innerHeight },
			overflow: document.documentElement.scrollWidth > innerWidth + 1,
			text:
				document.querySelector("dialog[open]")?.innerText ??
				document.querySelector("#conversation-scroll").innerText,
		}));
		assert.equal(view.overflow, false);
		evidence.views.push({ name, ...view });
		await page.screenshot({ path: `${root}/${name}.png`, fullPage: true });
	};
	const say = async (text) => {
		const pending = page.waitForResponse(
			(r) => r.url().endsWith("/intro/turn") && r.request().method() === "POST",
			{ timeout: 85000 },
		);
		await page.locator("#message").fill(text);
		await page.locator("#send").click();
		const r = await pending;
		assert.equal(r.status(), 200);
		await settled();
		const s = await r.json();
		evidence.answers.push({
			text,
			reply: s.turns.at(-1)?.reply,
			user: s.room.data.user,
			ready: s.room.data.ready,
		});
		return s;
	};
	await page.goto(base);
	await settled();
	let state = await snap();
	const firstRoomUrl = page.url();
	assert.match(state.turns.at(-1).reply, /이름|호칭|불러|부르/);
	assert.equal(state.room.data.ready, false);
	assert.equal(await page.locator("dialog[open]").count(), 0);
	evidence.answers.push({ opening: state.turns.at(-1).reply });
	await capture("profile-first-desktop");
	for (const width of [1024, 768, 390, 320]) {
		await page.setViewportSize({ width, height: 900 });
		await capture(`profile-first-${width}`);
	}
	await page.setViewportSize({ width: 1440, height: 900 });
	state = await say("유진이라고 불러줘.");
	assert.match(state.room.data.user.address, /유진/);
	assert.equal(state.room.data.ready, false);
	assert.match(state.turns.at(-1).reply, /일상|일|생활|시간|요즘/);
	state = await say("작은 공방을 운영하고 있고 평일 낮에는 도자기를 만들어.");
	assert.equal(state.room.data.ready, false);
	state = await say(
		"사진과 커피에 관심이 많고, 여기서는 공방 소식 글을 같이 다듬고 싶어.",
	);
	assert.equal(state.room.data.ready, false);
	state = await say("짧고 구체적으로 말해주고, 질문은 한 번에 하나씩 해줘.");
	assert.match(state.room.data.user.communication, /짧|구체/);
	await page.reload();
	await settled();
	assert.match((await snap()).room.data.user.address, /유진/);
	evidence.steps.push("astra-basic-profile-coverage-source-reload");
	await page.locator("[data-intro-action=review]").click();
	await capture("profile-review");
	await page.locator("[data-intro-action=confirm-user]").click();
	await page.locator("[data-intro-action=choose-custom]").waitFor();
	assert.equal(await page.locator("[data-intro-action=choose]").count(), 1);
	assert.equal(
		await page
			.locator("[data-intro-action=choose][data-preset-id=lina]")
			.count(),
		1,
	);
	await capture("first-two-choices");
	await page.setViewportSize({ width: 390, height: 844 });
	await capture("first-two-mobile");
	await page.locator("[data-intro-action=choose][data-preset-id=lina]").click();
	await page.waitForURL(/\?agent=lina/, { timeout: 30000 });
	await page.waitForFunction(
		() => document.querySelector("#connection-status").hidden,
		null,
		{ timeout: 30000 },
	);
	await capture("ordinary-empty");
	for (const old of [firstRoomUrl, base + "/?onboarding=user"]) {
		await page.goto(old);
		await page.waitForURL(/\?agent=lina/);
		assert.equal(await page.locator("body.intro-active").count(), 0);
	}
	evidence.steps.push("completed-first-setup-urls-redirect");
	await page.locator("#message").fill("헬로리나");
	await page.locator("#send").click();
	await page.waitForFunction(
		() =>
			[...document.querySelectorAll(".message.assistant .message-body")].some(
				(e) => e.textContent.length > 60,
			),
		null,
		{ timeout: 90000 },
	);
	await page.waitForFunction(
		() => document.querySelector("#cancel-run").hidden,
		null,
		{ timeout: 90000 },
	);
	const greeting = await page
		.locator(".message.assistant .message-body")
		.last()
		.innerText();
	assert.match(greeting, /리나/);
	// The handoff may use their name OR a relevant confirmed detail, naturally.
	assert.match(greeting, /유진|공방/);
	assert.match(greeting, /대화|공방|글|일/);
	evidence.answers.push({ firstOrdinary: greeting });
	evidence.steps.push("lina-first-response-context-and-personalization");
	await capture("ordinary-first-greeting");
	await page.setViewportSize({ width: 1440, height: 900 });
	const before = await page.evaluate(async () =>
		(await fetch("/api/agents")).json(),
	);
	await page.locator("#add-agent").click();
	await page.locator("#template-dialog [data-template-id]").first().waitFor();
	assert.equal(
		await page.locator("#template-dialog [data-template-id]").count(),
		8,
	);
	assert.equal(
		await page.locator("#template-dialog [data-template-id=lina]").count(),
		0,
	);
	assert.equal(await page.locator("#template-dialog input").count(), 0);
	const unchanged = await page.evaluate(async () =>
		(await fetch("/api/agents")).json(),
	);
	assert.equal(unchanged.agents.length, before.agents.length);
	await capture("later-template-picker");
	await page.setViewportSize({ width: 390, height: 844 });
	await capture("later-template-mobile");
	const born = page.waitForResponse(
		(r) =>
			r.url().endsWith("/api/agents/birth") && r.request().method() === "POST",
	);
	await page.locator("#template-dialog [data-template-id=sion]").click();
	const birth = await born;
	assert.equal(birth.status(), 200);
	await page.waitForURL(/onboarding=/);
	const roomId = new URL(page.url()).searchParams.get("onboarding");
	assert.ok(roomId);
	const created = await page.evaluate(async (id) => {
		const value = await (await fetch(`/api/onboarding/rooms/${id}`)).json();
		return {
			agentId: value.room?.agentId,
			roomId: value.room?.id,
			kind: value.room?.kind,
		};
	}, roomId);
	assert.match(created.agentId, /^agent-/);
	assert.equal(created.roomId, roomId);
	assert.equal(created.kind, "persona");
	await settled();
	assert.equal(await page.locator("dialog[open]").count(), 0);
	await capture("template-interview");
	const opening = await page
		.locator("#messages .message.assistant")
		.last()
		.innerText();
	assert.match(opening, /리나/);
	assert.match(opening, /시온|Sion/);
	assert.doesNotMatch(opening, /(?:저는|나는)\s*(?:시온|Sion)/);
	evidence.answers.push({ templateGuide: opening });
	let target = await say(
		"이 에이전트의 이름은 시온으로 두고, 도자기 작업 일정을 정리하는 차분한 동료로 만들어줘. 말투는 존댓말로 짧고 명확하게. 이 설정으로 마무리하자.",
	);
	assert.match(target.room.data.profile.name, /시온|Sion/);
	await page.locator("[data-intro-action=review]").click();
	await page.locator("[data-intro-action=confirm-persona]").click();
	await page.waitForURL(new RegExp(`agent=${created.agentId}`));
	await page.waitForFunction(
		() => document.querySelector("#connection-status").hidden,
		null,
		{ timeout: 30000 },
	);
	await page.locator("#message").fill("안녕, 네 이름과 맡은 일을 짧게 알려줘.");
	await page.locator("#send").click();
	await page.waitForFunction(
		() =>
			document.querySelector(".message.assistant .message-body")?.textContent
				.length > 20 && document.querySelector("#cancel-run").hidden,
		null,
		{ timeout: 90000 },
	);
	const answer = await page
		.locator(".message.assistant .message-body")
		.last()
		.innerText();
	assert.match(answer, /시온|Sion/);
	assert.match(answer, /도자기|일정/);
	evidence.answers.push({ confirmedAgent: answer });
	await capture("created-agent-handoff");
	await page.goto(base + "/?onboarding=" + created.roomId);
	await page.waitForURL(new RegExp(`agent=${created.agentId}`));
	await page.setViewportSize({ width: 1440, height: 900 });
	await page.locator("#add-agent").click();
	await page.locator("#template-custom").click();
	await page.waitForURL(/onboarding=/);
	await settled();
	const customOpening = await page
		.locator("#messages .message.assistant")
		.last()
		.innerText();
	assert.match(customOpening, /리나/);
	evidence.answers.push({ customGuide: customOpening });
	target = await say(
		"새봄이라는 에이전트를 만들고 싶어. 봄 풍경과 사진 기록을 정리하는 다정한 친구고 반말을 써. 이 정도로 마무리하자.",
	);
	assert.match(target.room.data.profile.name, /새봄/);
	assert.doesNotMatch(target.turns.at(-1).reply, /(?:저는|나는)\s*새봄/);
	await page.reload();
	await settled();
	await capture("custom-lina-guide");
	await page.locator("[data-intro-action=review]").click();
	await page.locator("[data-intro-action=confirm-persona]").click();
	await page.waitForURL(/\?agent=agent-/);
	evidence.steps.push("lina-guided-custom-template-confirm-and-handoff");
	evidence.template = created;
	evidence.steps.push("later-eight-templates-personal-copy-conversation");
	assert.equal(evidence.errors.length, 0);
	console.log(
		JSON.stringify({
			root,
			steps: evidence.steps,
			answers: evidence.answers,
			errors: evidence.errors,
		}),
	);
} finally {
	fs.writeFileSync(
		root + "/first-run-browser.json",
		JSON.stringify(evidence, null, 2),
	);
	await browser.close();
}
