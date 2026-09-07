import type { ReactNode } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";

/** The controller owns the host; React alone owns all descendants. */
export function mountView(host: HTMLElement) {
	const root = createRoot(host);
	return {
		render(node: ReactNode) {
			// Legacy callers may query/focus the view immediately after this call.
			flushSync(() => root.render(node));
		},
		destroy() {
			root.unmount();
		},
	};
}
