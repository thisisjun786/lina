import { readTheme, resolveTheme } from "./theme.ts";

// Blocking head asset: choose appearance before the first stylesheet can paint.
try {
	document.documentElement.setAttribute(
		"data-theme",
		resolveTheme(
			readTheme(window.localStorage),
			matchMedia("(prefers-color-scheme: dark)").matches,
		),
	);
} catch {
	document.documentElement.setAttribute("data-theme", "dark");
}
