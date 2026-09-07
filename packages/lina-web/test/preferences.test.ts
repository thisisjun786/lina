import { expect, test } from "bun:test";
import {
	DEFAULT_PREFERENCES,
	readPreferences,
	savePreferences,
	shouldSend,
} from "../../lina-client/src/preferences.ts";
import {
	readTheme,
	resolveTheme,
	saveTheme,
} from "../../lina-ui/client/theme.ts";

test("browser preferences validate saved values and survive blocked storage", () => {
	let value: string | null = null;
	const storage = {
		getItem: () => value,
		setItem: (_key: string, next: string) => {
			value = next;
		},
	};
	expect(readPreferences(storage)).toEqual(DEFAULT_PREFERENCES);
	expect(
		savePreferences(storage, {
			textSize: "large",
			sendKey: "modifier",
			sidebarCollapsed: true,
			sidebarWidth: 304,
		}),
	).toBe(true);
	expect(readPreferences(storage)).toEqual({
		textSize: "large",
		sendKey: "modifier",
		sidebarCollapsed: true,
		sidebarWidth: 304,
	});
	value = '{"textSize":"huge","sendKey":"wrong","sidebarCollapsed":"yes"}';
	expect(readPreferences(storage)).toEqual(DEFAULT_PREFERENCES);
	expect(
		readPreferences({
			getItem: () => {
				throw Error("blocked");
			},
		}),
	).toEqual(DEFAULT_PREFERENCES);
	expect(
		savePreferences(
			{
				setItem: () => {
					throw Error("blocked");
				},
			},
			DEFAULT_PREFERENCES,
		),
	).toBe(false);
});
test("send preference respects Korean composition, modifiers and explicit line breaks", () => {
	const event = {
		key: "Enter",
		shiftKey: false,
		ctrlKey: false,
		metaKey: false,
		altKey: false,
		isComposing: false,
		keyCode: 13,
	};
	expect(shouldSend(event, "enter")).toBe(true);
	expect(shouldSend(event, "modifier")).toBe(false);
	expect(shouldSend({ ...event, metaKey: true }, "modifier")).toBe(true);
	expect(shouldSend({ ...event, ctrlKey: true }, "modifier")).toBe(true);
	for (const extra of [
		{ isComposing: true },
		{ keyCode: 229 },
		{ shiftKey: true },
		{ altKey: true },
		{ key: "a" },
	])
		expect(shouldSend({ ...event, ...extra }, "enter")).toBe(false);
});
test("system preference resolves against OS while explicit theme wins", () => {
	let value: string | null = null;
	const storage = {
		getItem: () => value,
		setItem: (_k: string, v: string) => {
			value = v;
		},
	};
	saveTheme(storage, "system");
	expect(readTheme(storage)).toBe("system");
	expect(resolveTheme("system", false)).toBe("light");
	expect(resolveTheme("system", true)).toBe("dark");
	expect(resolveTheme("dark", false)).toBe("dark");
	expect(resolveTheme("light", true)).toBe("light");
});

test("sidebar width validates legacy and damaged device values and preserves a chosen size", () => {
	const read = (sidebarWidth: unknown) =>
		readPreferences({ getItem: () => JSON.stringify({ sidebarWidth }) });
	expect(read(undefined).sidebarWidth).toBe(304);
	expect(read(340).sidebarWidth).toBe(340);
	expect(read(120).sidebarWidth).toBe(200);
	expect(read(900).sidebarWidth).toBe(420);
	expect(read("340").sidebarWidth).toBe(304);
	expect(read(null).sidebarWidth).toBe(304);
	let saved = "";
	const storage = {
		getItem: () => saved,
		setItem: (_key: string, value: string) => {
			saved = value;
		},
	};
	savePreferences(storage, { ...DEFAULT_PREFERENCES, sidebarWidth: 340 });
	expect(readPreferences(storage).sidebarWidth).toBe(340);
});
