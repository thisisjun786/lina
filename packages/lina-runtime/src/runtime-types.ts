import type { SessionSnapshot } from "../../lina-core/src/protocol.ts";

export type RuntimeOptions = {
	beforeAbort?: () => void;
	beforeSubmit?: () => void;
};
export type RuntimeNotice =
	| { type: "snapshot"; snapshot: SessionSnapshot }
	| { type: "live-text"; sessionId: string; text: string }
	| { type: "legacy-text"; text: string }
	| { type: "warning"; message: string };
