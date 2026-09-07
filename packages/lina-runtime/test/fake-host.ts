import type { LinaHost } from "../src/host.ts";

/** Any native event handler, recorded so a test can fire it without knowing the event payload. */
type CapturedHandler = (...args: never[]) => void;

export function fakeHost() {
	const registered: string[] = [];
	const sent: string[] = [];
	const handlers = new Map<string, CapturedHandler[]>();
	const api: LinaHost = {
		registerTool(tool) {
			registered.push(tool.name);
		},
		on(event: string, handler: CapturedHandler) {
			handlers.set(event, [...(handlers.get(event) ?? []), handler]);
		},
		sendUserMessage(content) {
			sent.push(
				typeof content === "string" ? content : JSON.stringify(content),
			);
		},
	};
	return {
		api,
		registered,
		sent,
		handlers,
		/** Fires every handler the extension registered for this native event, in registration order. */
		emit(event: string): void {
			for (const handler of handlers.get(event) ?? []) handler();
		},
	};
}
