import { contextBridge, ipcRenderer } from "electron";

// Never expose ipcRenderer, Node primitives, filesystem paths or transport secrets.
contextBridge.exposeInMainWorld(
	"linaDesktop",
	Object.freeze({
		platform: "desktop",
		openExternal: (url: string): Promise<void> =>
			ipcRenderer.invoke("lina:open-external", url),
		notify: (input: { title: string; body: string }): Promise<boolean> =>
			ipcRenderer.invoke("lina:notify", input),
	}),
);
