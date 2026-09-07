import type { ControlSnapshot } from "../../lina-core/src/control/types.ts";
import type {
	ControlClient,
	ControlServer,
} from "../../lina-core/src/control-wire.ts";

export class ExecutionModel {
	state: ControlSnapshot | undefined;
	connected = false;
	error = "";
	get cancelFailed(): boolean {
		return this.state?.cancelFailed ?? false;
	}
	private localCancel = false;
	private readonly decisions = new Set<string>();
	bindSession(sessionId: string | undefined): void {
		if (this.state && this.state.sessionId !== sessionId) {
			this.state = undefined;
			this.connected = false;
			this.localCancel = false;
			this.error = "";
			this.decisions.clear();
		}
	}

	receive(frame: ControlServer, sessionId: string | undefined): void {
		this.bindSession(sessionId);
		if (frame.type === "control-error") {
			this.error = frame.message;
			this.localCancel = false;
			this.decisions.clear();
			return;
		}
		if (
			frame.state.sessionId !== sessionId ||
			(this.state?.sessionId === sessionId &&
				frame.state.revision < this.state.revision)
		)
			return;
		this.state = frame.state;
		this.connected = true;
		this.localCancel = false;
		for (const id of this.decisions)
			if (
				!frame.state.approvals.some(
					(approval) => approval.id === id && approval.state === "pending",
				)
			)
				this.decisions.delete(id);
	}
	cancelCommand(): Extract<ControlClient, { type: "cancel" }> | undefined {
		const state = this.state;
		if (
			!this.connected ||
			!state?.cancelRequestId ||
			this.localCancel ||
			(state.cancelling && !this.cancelFailed)
		)
			return;
		return {
			type: "cancel",
			sessionId: state.sessionId,
			requestId: state.cancelRequestId,
		};
	}
	approvalCommand(
		id: string,
		decision: "allow" | "deny",
	): Extract<ControlClient, { type: "approval_reply" }> | undefined {
		const state = this.state,
			approval = state?.approvals.find((item) => item.id === id);
		if (
			!this.connected ||
			!state ||
			state.cancelling ||
			!approval ||
			approval.state !== "pending" ||
			this.decisions.has(id)
		)
			return;
		return {
			type: "approval_reply",
			sessionId: state.sessionId,
			id,
			inputDigest: approval.inputDigest,
			decision,
		};
	}
	sent(frame: ControlClient): void {
		this.error = "";
		if (frame.type === "cancel") {
			this.localCancel = true;
		} else this.decisions.add(frame.id);
	}
	failed(): void {
		this.error = "전송 실패 · 연결 끊김";
		this.localCancel = false;
		this.decisions.clear();
	}
	disconnect(): void {
		this.connected = false;
		this.localCancel = false;
		this.decisions.clear();
	}
}
