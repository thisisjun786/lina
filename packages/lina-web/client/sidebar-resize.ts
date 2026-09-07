import {
	SIDEBAR_DEFAULT_WIDTH,
	SIDEBAR_MAX_WIDTH,
	SIDEBAR_MIN_WIDTH,
} from "./preferences.ts";
import { element } from "./render.ts";
import type { createSettings } from "./settings.ts";
export function installSidebarResize(
	settings: ReturnType<typeof createSettings>,
): void {
	const handle = element("sidebar-resizer", HTMLHRElement),
		sidebar = element("sidebar", HTMLElement),
		root = document.documentElement;
	let drag: { pointer: number; start: number; width: number } | undefined;
	const max = () =>
		Math.max(
			SIDEBAR_MIN_WIDTH,
			Math.min(SIDEBAR_MAX_WIDTH, Math.floor(window.innerWidth * 0.45)),
		);
	const clamp = (width: number) =>
		Math.max(SIDEBAR_MIN_WIDTH, Math.min(max(), Math.round(width)));
	const announce = () => {
		handle.setAttribute("aria-valuemin", String(SIDEBAR_MIN_WIDTH));
		handle.setAttribute("aria-valuemax", String(max()));
		handle.setAttribute(
			"aria-valuenow",
			String(clamp(sidebar.getBoundingClientRect().width)),
		);
	};
	const show = (width: number) => {
		root.style.setProperty("--sidebar-width", `${width}px`);
		announce();
	};
	const finish = (commit: boolean) => {
		const current = drag;
		if (!current) return;
		drag = undefined;
		delete root.dataset["sidebarResizing"];
		if (handle.hasPointerCapture(current.pointer))
			handle.releasePointerCapture(current.pointer);
		if (commit) settings.update({ sidebarWidth: current.width });
		else show(current.start);
		announce();
	};
	handle.addEventListener("pointerdown", (event) => {
		if (event.button !== 0 || !event.isPrimary) return;
		event.preventDefault();
		handle.focus();
		drag = {
			pointer: event.pointerId,
			start: settings.preferences.sidebarWidth,
			width: clamp(sidebar.getBoundingClientRect().width),
		};
		handle.setPointerCapture(event.pointerId);
		root.dataset["sidebarResizing"] = "true";
	});
	handle.addEventListener("pointermove", (event) => {
		if (drag?.pointer !== event.pointerId) return;
		drag.width = clamp(event.clientX - sidebar.getBoundingClientRect().left);
		show(drag.width);
	});
	handle.addEventListener("pointerup", (event) => {
		if (drag?.pointer === event.pointerId) finish(true);
	});
	handle.addEventListener("pointercancel", () => finish(false));
	handle.addEventListener("lostpointercapture", () => finish(false));
	window.addEventListener("blur", () => finish(false));
	handle.addEventListener("keydown", (event) => {
		if (event.key === "Escape" && drag) {
			event.preventDefault();
			finish(false);
			return;
		}
		const current = sidebar.getBoundingClientRect().width;
		const next =
			event.key === "Home"
				? SIDEBAR_MIN_WIDTH
				: event.key === "End"
					? max()
					: event.key === "ArrowLeft"
						? current - (event.shiftKey ? 32 : 8)
						: event.key === "ArrowRight"
							? current + (event.shiftKey ? 32 : 8)
							: undefined;
		if (next === undefined) return;
		event.preventDefault();
		settings.update({ sidebarWidth: clamp(next) });
		announce();
	});
	handle.addEventListener("dblclick", () => {
		settings.update({ sidebarWidth: SIDEBAR_DEFAULT_WIDTH });
		announce();
	});
	window.addEventListener("resize", () => {
		finish(false);
		announce();
	});
	new ResizeObserver(announce).observe(sidebar);
	announce();
}
