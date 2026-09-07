export const SIDEBAR_MIN_WIDTH = 200;
export const SIDEBAR_MAX_WIDTH = 420;
export const SIDEBAR_DEFAULT_WIDTH = 304;
export function normalizeSidebarWidth(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value)
		? Math.max(
				SIDEBAR_MIN_WIDTH,
				Math.min(SIDEBAR_MAX_WIDTH, Math.round(value)),
			)
		: SIDEBAR_DEFAULT_WIDTH;
}
export type Preferences = {
	textSize: "standard" | "large";
	sendKey: "enter" | "modifier";
	sidebarCollapsed: boolean;
	sidebarWidth: number;
};
export type PreferenceStorage = {
	getItem(key: string): string | null;
	setItem(key: string, value: string): void;
};
export const DEFAULT_PREFERENCES: Readonly<Preferences> = {
	textSize: "standard",
	sendKey: "enter",
	sidebarCollapsed: false,
	sidebarWidth: SIDEBAR_DEFAULT_WIDTH,
};
const KEY = "lina.preferences.v1";
/** Device preferences only. Browser storage is an adapter, never agent state. */
export function readPreferences(
	storage?: Pick<PreferenceStorage, "getItem">,
): Preferences {
	try {
		const raw: unknown = JSON.parse(storage?.getItem(KEY) ?? "null");
		if (raw && typeof raw === "object" && !Array.isArray(raw)) {
			const v = raw as Record<string, unknown>;
			return {
				textSize: v["textSize"] === "large" ? "large" : "standard",
				sendKey: v["sendKey"] === "modifier" ? "modifier" : "enter",
				sidebarCollapsed: v["sidebarCollapsed"] === true,
				sidebarWidth: normalizeSidebarWidth(v["sidebarWidth"]),
			};
		}
	} catch {}
	return { ...DEFAULT_PREFERENCES };
}
export function savePreferences(
	storage: Pick<PreferenceStorage, "setItem"> | undefined,
	value: Preferences,
): boolean {
	try {
		storage?.setItem(KEY, JSON.stringify(value));
		return !!storage;
	} catch {
		return false;
	}
}
type KeyInput = {
	key: string;
	shiftKey: boolean;
	ctrlKey: boolean;
	metaKey: boolean;
	altKey: boolean;
	isComposing: boolean;
	keyCode: number;
};
export function shouldSend(
	event: KeyInput,
	mode: Preferences["sendKey"],
): boolean {
	return (
		event.key === "Enter" &&
		!event.shiftKey &&
		!event.altKey &&
		!event.isComposing &&
		event.keyCode !== 229 &&
		(mode === "enter" || event.ctrlKey || event.metaKey)
	);
}
