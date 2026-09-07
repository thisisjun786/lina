import { createElement } from "react";
import { mountView } from "./components/mount.ts";
import { ThemeControlsView } from "./components/theme-controls.tsx";
import { readTheme, resolveTheme, saveTheme, type Theme } from "./theme.ts";

export function installThemeControls(failed: () => void = () => {}): void {
	let storage: Storage | undefined;
	try {
		storage = window.localStorage;
	} catch {}
	let preference = readTheme(storage);
	const system = matchMedia("(prefers-color-scheme: dark)");
	// Each host keeps its accessible label and attributes; React owns its choices.
	const views = Array.from(
		document.querySelectorAll<HTMLElement>(".theme-switch"),
		mountView,
	);
	const apply = () => {
		document.documentElement.dataset["theme"] = resolveTheme(
			preference,
			system.matches,
		);
		for (const view of views)
			view.render(createElement(ThemeControlsView, { preference, select }));
		document
			.querySelector('meta[name="theme-color"]')
			?.setAttribute(
				"content",
				getComputedStyle(document.documentElement)
					.getPropertyValue("--surface-main")
					.trim(),
			);
	};
	const select = (next: Theme) => {
		preference = next;
		apply();
		if (!saveTheme(storage, preference)) failed();
	};
	system.addEventListener("change", () => {
		if (preference === "system") apply();
	});
	apply();
}
