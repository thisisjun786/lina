import { installHubSettings } from "./hub-settings.ts";
import { installModelSettings } from "./model-settings.ts";
import {
	type Preferences,
	readPreferences,
	savePreferences,
} from "./preferences.ts";
import { element, setText } from "./render.ts";
import { installSettingsTabs } from "./settings-tabs.ts";
import { installThemeControls } from "./theme-controls.ts";

/** Device settings; platform-specific install/update controls live in pwa.ts. */
export function createSettings() {
	const dialog = element("settings-dialog", HTMLDialogElement),
		status = element("settings-status", HTMLParagraphElement);
	let storage: Storage | undefined;
	try {
		storage = window.localStorage;
	} catch {}
	let preferences = readPreferences(storage),
		returnFocus: HTMLElement | undefined;
	const models = installModelSettings(dialog);
	let modelsLoaded = false,
		hubLoaded = false;
	const hub = installHubSettings(dialog, {
		onModels: () => tabs.select("models", true),
		onChanged: () => {
			if (modelsLoaded && dialog.open) void models.refresh();
		},
	});
	const tabs = installSettingsTabs(dialog, (tab) => {
		if (tab === "models" && !modelsLoaded) {
			modelsLoaded = true;
			void models.open();
		}
		if (tab === "connections" && !hubLoaded) {
			hubLoaded = true;
			void hub.open();
		}
	});
	element("model-connect-provider", HTMLButtonElement).addEventListener(
		"click",
		() => tabs.select("connections", true),
	);
	const failed = () => setText(status, "설정을 저장하지 못했습니다.");
	installThemeControls(failed);
	const apply = () => {
		document.documentElement.style.setProperty(
			"--sidebar-width",
			`${preferences.sidebarWidth}px`,
		);
		document.documentElement.dataset["textSize"] = preferences.textSize;
		document.documentElement.dataset["sidebarCollapsed"] = String(
			preferences.sidebarCollapsed,
		);
		for (const input of dialog.querySelectorAll<HTMLInputElement>(
			'input[name="text-size"],input[name="send-key"]',
		))
			input.checked =
				input.value ===
				(input.name === "text-size"
					? preferences.textSize
					: preferences.sendKey);
	};
	const update = (patch: Partial<Preferences>) => {
		preferences = { ...preferences, ...patch };
		apply();
		setText(status, "");
		if (!savePreferences(storage, preferences)) failed();
	};
	dialog.addEventListener("change", (event) => {
		const input = event.target;
		if (!(input instanceof HTMLInputElement)) return;
		if (input.name === "text-size")
			update({ textSize: input.value === "large" ? "large" : "standard" });
		if (input.name === "send-key")
			update({ sendKey: input.value === "modifier" ? "modifier" : "enter" });
	});
	for (const button of dialog.querySelectorAll("[data-close]"))
		button.addEventListener("click", () => dialog.close());
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
	dialog.addEventListener("close", () => {
		models.close();
		hub.close();
		modelsLoaded = false;
		hubLoaded = false;
		if (returnFocus?.isConnected) returnFocus.focus();
	});
	document.addEventListener("lina:model-settings", (event) => {
		if (!(event instanceof CustomEvent)) return;
		const detail = event.detail as { agentId: string; opener: HTMLElement };
		returnFocus = detail.opener;
		if (!dialog.open) dialog.showModal();
		modelsLoaded = true;
		void models.open(detail.agentId);
		tabs.select("models");
	});
	document.addEventListener("lina:provider-settings", () => {
		if (!dialog.open) {
			returnFocus =
				document.activeElement instanceof HTMLElement
					? document.activeElement
					: undefined;
			dialog.showModal();
		}
		tabs.select("connections", true);
	});
	apply();
	return {
		get preferences() {
			return preferences;
		},
		update,
		open(opener: HTMLElement) {
			returnFocus = opener;
			if (!dialog.open) dialog.showModal();
			tabs.select(tabs.current);
		},
		openForAgent(agentId: string, opener: HTMLElement) {
			returnFocus = opener;
			if (!dialog.open) dialog.showModal();
			modelsLoaded = true;
			void models.open(agentId);
			tabs.select("models");
		},
	};
}
