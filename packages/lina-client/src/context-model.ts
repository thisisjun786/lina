import type {
	ContextClient,
	ContextServer,
	ContextSnapshot,
} from "../../lina-core/src/context-wire.ts";

export class ContextModel {
	state: ContextSnapshot | undefined;
	connected = false;
	running = false;
	error = "";
	private sessionId: string | undefined;
	private pending = false;
	bindSession(id: string | undefined): void {
		if (this.sessionId !== id) {
			this.state = undefined;
			this.error = "";
			this.pending = false;
		}
		this.sessionId = id;
	}
	receive(frame: ContextServer): void {
		if (frame.type === "context-error") {
			this.error = frame.message;
			this.pending = false;
			return;
		}
		if (frame.state.sessionId !== this.sessionId) return;
		if (
			this.state?.epoch === frame.state.epoch &&
			frame.state.revision < this.state.revision
		)
			return;
		this.state = frame.state;
		this.pending = false;
	}
	command(type: ContextClient["type"]): ContextClient | undefined {
		if (!this.connected || !this.sessionId || !this.state || this.pending)
			return;
		if (type === "compact" && (this.running || this.state.busy)) return;
		return { type, sessionId: this.sessionId };
	}
	sent(): void {
		this.pending = true;
		this.error = "";
	}
	disconnect(): void {
		this.connected = false;
		this.pending = false;
	}
	failed(): void {
		this.pending = false;
		this.error = "연결 확인 후 다시 시도";
	}
}
