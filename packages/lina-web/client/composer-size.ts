import { element, setText } from "./render.ts";
/** Content sizing belongs to this view, not the session or persisted draft. */
export function createComposerSizing(input: HTMLTextAreaElement) {
	const toggle = element("expand-composer", HTMLButtonElement);
	const conversation = element("conversation-scroll", HTMLDivElement);
	let expanded = false,
		lastValue: string | undefined,
		lastWidth = -1,
		lastViewport = -1;
	const update = (force = false) => {
		const width = input.clientWidth,
			viewport = Math.min(
				window.innerHeight,
				window.visualViewport?.height ?? window.innerHeight,
			);
		if (
			!force &&
			input.value === lastValue &&
			width === lastWidth &&
			viewport === lastViewport
		)
			return;
		lastValue = input.value;
		lastWidth = width;
		lastViewport = viewport;
		const style = getComputedStyle(input);
		const line = Number.parseFloat(style.lineHeight);
		const padding =
			Number.parseFloat(style.paddingTop) +
			Number.parseFloat(style.paddingBottom);
		// Fit complete rows so focusing the end of a long draft does not clip
		// the first visible line halfway through its glyphs.
		const fit = (limit: number) =>
			Math.max(44, Math.floor((limit - padding) / line) * line + padding);
		const normal = fit(Math.min(180, viewport * 0.28)),
			large = Math.max(normal, fit(Math.min(420, viewport * 0.48)));
		const pinned =
			conversation.scrollHeight -
				conversation.scrollTop -
				conversation.clientHeight <
			2;
		const scroll = input.scrollTop;
		input.style.height = "0px";
		const content = input.scrollHeight;
		const canExpand = content > normal + 2 && large > normal + 16;
		if (!canExpand) expanded = false;
		const height = expanded ? large : Math.max(44, Math.min(content, normal));
		input.style.height = `${height}px`;
		input.style.overflowY = content > height + 1 ? "auto" : "hidden";
		input.scrollTop = scroll;
		if (pinned) conversation.scrollTop = conversation.scrollHeight;
		toggle.hidden = !canExpand;
		toggle.setAttribute("aria-expanded", String(expanded));
		toggle.setAttribute(
			"aria-label",
			expanded ? "입력창 줄이기" : "입력창 넓히기",
		);
		setText(toggle, expanded ? "줄이기" : "크게 쓰기");
	};
	toggle.addEventListener("click", () => {
		const start = input.selectionStart,
			end = input.selectionEnd;
		expanded = !expanded;
		update(true);
		input.focus({ preventScroll: true });
		input.setSelectionRange(start, end);
	});
	window.addEventListener("resize", () => update());
	window.visualViewport?.addEventListener("resize", () => update());
	new ResizeObserver(() => update()).observe(input);
	return { update };
}
