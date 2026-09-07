import { basename, join } from "node:path";
import {
	BrowserWindow,
	dialog,
	type IpcMainInvokeEvent,
	ipcMain,
	Notification,
	type Session,
	shell,
} from "electron";
import { externalUrl } from "./config.ts";
import {
	downloadUrl,
	notificationInput,
	rendererRequest,
	windowUrl,
} from "./window-policy.ts";

async function openOsLink(
	window: BrowserWindow,
	raw: unknown,
	origins: readonly string[],
): Promise<void> {
	try {
		await shell.openExternal(externalUrl(raw, origins));
	} catch {
		if (!window.isDestroyed())
			await dialog.showMessageBox(window, {
				type: "error",
				message: "연결된 앱에서 링크를 열지 못했습니다.",
				detail:
					typeof raw === "string" && raw.startsWith("codex:")
						? "Codex 앱이 설치되어 있고 링크를 열도록 연결되어 있는지 확인해주세요."
						: "허용된 HTTPS 사이트와 기본 브라우저 설정을 확인해주세요.",
			});
		throw Error("External link could not be opened.");
	}
}

export async function prepareSession(
	session: Session,
	origin: string,
): Promise<void> {
	await session.setProxy({ mode: "direct" });
	session.setPermissionRequestHandler((_contents, _permission, callback) =>
		callback(false),
	);
	session.setPermissionCheckHandler(() => false);
	session.on("will-download", (event, item, contents) => {
		if (
			!contents ||
			!windowUrl(contents.getURL(), origin) ||
			!item.getURLChain().every((url) => downloadUrl(url, origin))
		) {
			event.preventDefault();
			return;
		}
		item.setSaveDialogOptions({
			title: "첨부 파일 저장",
			defaultPath: basename(item.getFilename()),
		});
	});
	// Cookies are not port-scoped. Deny every other origin before any network request.
	session.webRequest.onBeforeRequest((details, callback) =>
		callback({ cancel: !rendererRequest(details.url, origin) }),
	);
}

export function createWindow(
	session: Session,
	origin: string,
	externalOrigins: readonly string[],
): BrowserWindow {
	const window = new BrowserWindow({
		title: "Lina",
		width: 1280,
		height: 860,
		minWidth: 680,
		minHeight: 520,
		backgroundColor: "#181818",
		show: false,
		webPreferences: {
			session,
			preload: join(__dirname, "preload.cjs"),
			contextIsolation: true,
			sandbox: true,
			nodeIntegration: false,
			nodeIntegrationInWorker: false,
			nodeIntegrationInSubFrames: false,
			webSecurity: true,
			allowRunningInsecureContent: false,
			webviewTag: false,
		},
	});
	const open = (raw: string) => {
		void openOsLink(window, raw, externalOrigins).catch(() => {
			// The native error dialog already reported this navigation failure.
		});
	};
	window.webContents.setWindowOpenHandler(({ url }) => {
		void open(url);
		return { action: "deny" };
	});
	window.webContents.on("will-navigate", (event, url) => {
		if (!windowUrl(url, origin)) {
			event.preventDefault();
			void open(url);
		}
	});
	window.webContents.on("will-redirect", (event) => event.preventDefault());
	window.webContents.on("will-attach-webview", (event) =>
		event.preventDefault(),
	);
	window.webContents.on("render-process-gone", () => {
		void dialog.showMessageBox(window, {
			type: "error",
			message: "화면이 종료되었습니다.",
			detail: "Lina 서버의 작업은 계속됩니다. 앱을 다시 열어주세요.",
		});
	});
	window.once("ready-to-show", () => window.show());
	void window.loadURL(origin).catch(() => {
		dialog.showErrorBox(
			"Lina",
			"동봉 화면을 열지 못했습니다. 앱을 다시 실행해주세요.",
		);
	});
	return window;
}

export function installOsHandlers(
	current: () => BrowserWindow | undefined,
	origin: string,
	externalOrigins: readonly string[],
): void {
	const authorize = (event: IpcMainInvokeEvent) => {
		const window = current();
		if (
			!window ||
			window.isDestroyed() ||
			event.sender !== window.webContents ||
			event.senderFrame !== window.webContents.mainFrame ||
			!event.senderFrame ||
			!windowUrl(event.senderFrame.url, origin)
		)
			throw Error("Unauthorized desktop request");
		return window;
	};
	ipcMain.handle("lina:open-external", async (event, raw: unknown) => {
		const window = authorize(event);
		await openOsLink(window, raw, externalOrigins);
	});
	ipcMain.handle("lina:notify", (event, raw: unknown) => {
		authorize(event);
		const input = notificationInput(raw);
		if (!Notification.isSupported()) return false;
		new Notification(input).show();
		return true;
	});
}
