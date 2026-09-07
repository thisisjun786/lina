import { mkdirSync } from "node:fs";
import { join } from "node:path";
import {
	app,
	type BrowserWindow,
	dialog,
	Menu,
	type MenuItemConstructorOptions,
	session,
} from "electron";
import { startBroker } from "./broker.ts";
import { loadBundle } from "./bundled-assets.ts";
import { desktopConfig } from "./config.ts";
import { bindProfile, createBrokerSession } from "./session.ts";
import { createWindow, installOsHandlers, prepareSession } from "./window.ts";

app.setName("Lina");
app.enableSandbox();

async function start(): Promise<void> {
	const config = desktopConfig(process.env);
	mkdirSync(config.userData, { recursive: true, mode: 0o700 });
	mkdirSync(config.sessionData, { recursive: true, mode: 0o700 });
	app.setPath("userData", config.userData);
	app.setPath("sessionData", config.sessionData);
	if (!app.requestSingleInstanceLock()) {
		app.quit();
		return;
	}
	await bindProfile(config);
	await app.whenReady();
	const credential = createBrokerSession();
	const broker = await startBroker({
		port: config.brokerPort,
		serverOrigin: config.serverOrigin,
		session: credential,
		assets: await loadBundle(join(__dirname, "assets")),
	});
	const desktopSession = session.fromPartition("persist:lina-desktop");
	await prepareSession(desktopSession, broker.origin);
	await desktopSession.cookies.set(credential.cookie(broker.origin));
	let window: BrowserWindow | undefined;
	const showWindow = () => {
		if (!window || window.isDestroyed())
			window = createWindow(
				desktopSession,
				broker.origin,
				config.externalOrigins,
			);
		else {
			if (window.isMinimized()) window.restore();
			window.show();
			window.focus();
		}
	};
	installOsHandlers(() => window, broker.origin, config.externalOrigins);
	const menu: MenuItemConstructorOptions[] = [
		...(process.platform === "darwin"
			? [{ role: "appMenu" as const }]
			: [{ label: "Lina", submenu: [{ role: "quit" as const }] }]),
		{ role: "editMenu" },
		{
			label: "보기",
			submenu: [
				{ role: "reload" },
				{ type: "separator" },
				{ role: "resetZoom" },
				{ role: "zoomIn" },
				{ role: "zoomOut" },
				{ role: "togglefullscreen" },
			],
		},
		{ role: "windowMenu" },
	];
	Menu.setApplicationMenu(Menu.buildFromTemplate(menu));
	app.on("second-instance", showWindow);
	app.on("activate", showWindow);
	app.on("window-all-closed", () => {
		if (process.platform !== "darwin") app.quit();
	});
	let stopping = false;
	// A renderer may veto window close to preserve an upload or unsaved draft.
	// Keep its transport alive until Electron confirms every window has closed.
	app.on("will-quit", (event) => {
		if (stopping) return;
		event.preventDefault();
		stopping = true;
		desktopSession.flushStorageData();
		void broker.close().finally(() => app.quit());
	});
	showWindow();
}
void start().catch(async (error: unknown) => {
	await app.whenReady();
	dialog.showErrorBox(
		"Lina desktop could not start",
		error instanceof Error ? error.message : "Desktop startup failed.",
	);
	app.exit(1);
});
