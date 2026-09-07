export type Theme = "dark" | "light" | "system";
export function resolveTheme(
	theme: Theme,
	systemDark: boolean,
): "dark" | "light" {
	return theme === "system" ? (systemDark ? "dark" : "light") : theme;
}
type ThemeStorage = {
	getItem(key: string): string | null;
	setItem(key: string, value: string): void;
};
const KEY = "lina.theme.v1";

export function readTheme(storage?: Pick<ThemeStorage, "getItem">): Theme {
	try {
		const value = storage?.getItem(KEY);
		return value === "light" || value === "system" ? value : "dark";
	} catch {
		return "dark";
	}
}

export function saveTheme(
	storage: Pick<ThemeStorage, "setItem"> | undefined,
	theme: Theme,
): boolean {
	try {
		storage?.setItem(KEY, theme);
		return storage !== undefined;
	} catch {
		return false;
	}
}
