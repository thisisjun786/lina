import { expect, test } from "bun:test";
import { readTheme, saveTheme } from "../../lina-ui/client/theme.ts";

test("appearance defaults to dark and preserves an explicit light preference", () => {
	let value: string | null = null;
	const storage = {
		getItem: () => value,
		setItem: (_key: string, next: string) => {
			value = next;
		},
	};
	expect(readTheme(storage)).toBe("dark");
	saveTheme(storage, "light");
	expect(readTheme(storage)).toBe("light");
	saveTheme(storage, "dark");
	expect(readTheme(storage)).toBe("dark");
	value = "invalid";
	expect(readTheme(storage)).toBe("dark");
});

test("blocked preference storage cannot prevent a dark usable interface", () => {
	const storage = {
		getItem(): string {
			throw new Error("blocked");
		},
		setItem() {
			throw new Error("blocked");
		},
	};
	expect(readTheme(storage)).toBe("dark");
	expect(saveTheme(storage, "light")).toBe(false);
	expect(readTheme()).toBe("dark");
});
