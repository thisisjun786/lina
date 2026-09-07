import { readTheme, resolveTheme, saveTheme } from "./theme.ts";
export function installThemeControls(failed: () => void = () => {}): void {
	const buttons = document.querySelectorAll<HTMLButtonElement>(
		"[data-theme-choice]",
	);
	let storage: Storage | undefined;
	try {
		storage = window.localStorage;
	} catch {}
	let preference = readTheme(storage);
	const system = matchMedia("(prefers-color-scheme: dark)");
	const apply = () => {
		document.documentElement.dataset["theme"] = resolveTheme(
			preference,
			system.matches,
		);
		for (const button of buttons)
			button.setAttribute(
				"aria-pressed",
				String(button.dataset["themeChoice"] === preference),
			);
		document
			.querySelector('meta[name="theme-color"]')
			?.setAttribute(
				"content",
				getComputedStyle(document.documentElement)
					.getPropertyValue("--surface-main")
					.trim(),
			);
	};
	for (const button of buttons)
		button.addEventListener("click", () => {
			const next = button.dataset["themeChoice"];
			preference = next === "light" || next === "system" ? next : "dark";
			apply();
			if (!saveTheme(storage, preference)) failed();
		});
	system.addEventListener("change", () => {
		if (preference === "system") apply();
	});
	apply();
}
