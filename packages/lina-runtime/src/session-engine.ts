import type { SdkSessionOptions } from "./host.ts";
import type { SessionPort } from "./sdk-port.ts";

/** Native identity and runtime construction are owned by the selected adapter. */
export interface SessionEngine {
	readonly kind: "codex";
	inspect(sessionFile: string, workspace: string): void;
	initialize(
		sessionFile: string,
		workspace: string,
	):
		| { sessionId: string; sessionFile: string }
		| Promise<{ sessionId: string; sessionFile: string }>;
	create(options: SdkSessionOptions): Promise<SessionPort>;
}
