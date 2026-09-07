import type { ServerFrame } from "../../lina-client/src/protocol.ts";
import {
	type SearchCommand,
	SearchModel,
} from "../../lina-client/src/search-model.ts";
import { renderUserBody } from "./attachments.ts";
import { renderMarkdown } from "./markdown.ts";
import { element, setText } from "./render.ts";
export function createSearch(send: (frame: SearchCommand) => boolean) {
	const model = new SearchModel(),
		dialog = element("search-dialog", HTMLDialogElement),
		input = element("search-query", HTMLInputElement),
		form = element("search-form", HTMLFormElement),
		list = element("search-results", HTMLDivElement),
		status = element("search-status", HTMLParagraphElement),
		detail = element("search-detail", HTMLElement),
		original = element("search-original", HTMLElement),
		pages = element("search-pages", HTMLDivElement),
		more = element("search-more", HTMLButtonElement),
		submit = element("search-submit", HTMLButtonElement),
		older = element("search-older", HTMLButtonElement),
		newer = element("search-newer", HTMLButtonElement);
	let returnFocus: HTMLElement | undefined,
		timer: ReturnType<typeof setTimeout> | undefined,
		rows = model.rows,
		rendered = "";
	const dispatch = (frame: SearchCommand | undefined) => {
		if (!frame) return;
		if (timer) clearTimeout(timer);
		if (!send(frame)) model.fail();
		else
			timer = setTimeout(() => {
				model.fail();
				render();
			}, 8000);
		render();
	};
	const render = () => {
		if (!model.pending && timer) {
			clearTimeout(timer);
			timer = undefined;
		}
		submit.disabled = !model.connected || !!model.pending;
		older.disabled = !model.connected || !!model.pending || !model.hasOlder;
		newer.disabled = !model.connected || !!model.pending || !model.hasNewer;
		const selected = model.selected;
		detail.hidden = !selected;
		list.hidden = !!selected;
		form.hidden = !!selected;
		pages.hidden = !!selected || !model.rows.length;
		setText(
			status,
			!model.connected
				? "연결 후 검색할 수 있습니다."
				: model.pending
					? model.pending.kind === "entry"
						? "불러오는 중"
						: "검색 중"
					: model.error ||
						(!model.rows.length && model.query
							? "검색 결과 없음"
							: model.limited
								? "긴 메시지의 앞부분입니다."
								: ""),
		);
		if (rows !== model.rows) {
			rows = model.rows;
			list.replaceChildren(
				...[...rows].reverse().map((row) => {
					const button = document.createElement("button");
					button.type = "button";
					button.className = "search-result";
					const meta = document.createElement("span");
					meta.className = "search-result-meta";
					const date = new Date(row.timestamp);
					meta.textContent = `${row.role === "assistant" ? "Lina" : "나"}${Number.isNaN(date.getTime()) ? "" : ` · ${date.toLocaleDateString("ko-KR")}`}`;
					const text = document.createElement("span");
					text.className = "search-result-text";
					text.textContent = row.text;
					button.append(meta, text);
					button.addEventListener("click", () => {
						dispatch(model.select(row.entryId));
						element("search-back", HTMLButtonElement).focus();
					});
					return button;
				}),
			);
		}
		const key = `${selected?.entryId}:${model.original}`;
		if (rendered !== key) {
			rendered = key;
			if (selected?.role === "assistant")
				renderMarkdown(original, model.original, model.sessionId);
			else renderUserBody(original, model.original, model.sessionId);
		}
		more.hidden = model.nextOffset === null;
		more.disabled = !model.connected || !!model.pending;
	};
	form.addEventListener("submit", (event) => {
		event.preventDefault();
		dispatch(model.search(input.value));
	});
	older.addEventListener("click", () =>
		dispatch(model.search(model.query, "older")),
	);
	newer.addEventListener("click", () =>
		dispatch(model.search(model.query, "newer")),
	);
	more.addEventListener("click", () => dispatch(model.more()));
	element("search-back", HTMLButtonElement).addEventListener("click", () => {
		model.back();
		render();
		input.focus();
	});
	for (const button of dialog.querySelectorAll("[data-close]"))
		button.addEventListener("click", () => dialog.close());
	dialog.addEventListener("close", () => {
		if (timer) clearTimeout(timer);
		model.cancel();
		returnFocus?.isConnected && returnFocus.focus();
	});
	dialog.addEventListener("click", (event) => {
		if (event.target === dialog) {
			const r = dialog.getBoundingClientRect();
			if (
				event.clientX < r.left ||
				event.clientX > r.right ||
				event.clientY < r.top ||
				event.clientY > r.bottom
			)
				dialog.close();
		}
	});
	return {
		open(opener: HTMLElement) {
			returnFocus = opener;
			model.back();
			render();
			if (!dialog.open) dialog.showModal();
			input.focus();
			input.select();
		},
		connect(connected: boolean, sessionId: string | undefined) {
			model.connect(connected, sessionId);
			render();
		},
		receive(frame: ServerFrame) {
			if (
				frame.type === "search-results" ||
				frame.type === "entry-text" ||
				frame.type === "search-error"
			) {
				model.receive(frame);
				render();
			}
		},
	};
}
