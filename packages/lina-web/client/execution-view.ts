import type { ControlClient } from "../../lina-core/src/control-wire.ts";
import type { ExecutionModel } from "./execution-model.ts";
import { element, setText } from "./render.ts";
import { approvalDescriptor, toolLabel } from "./tool-label.ts";

export function createExecutionView(
	model: ExecutionModel,
	send: (frame: ControlClient) => boolean,
	changed: () => void,
) {
	const approvals = element("approval-list", HTMLDivElement);
	const stop = element("cancel-run", HTMLButtonElement);
	const error = element("execution-error", HTMLParagraphElement);
	const approvalNodes = new Map<string, HTMLElement>();
	const dispatch = (frame: ControlClient | undefined) => {
		if (!frame) return;
		model.sent(frame);
		if (!send(frame)) model.failed();
		changed();
	};
	stop.addEventListener("click", () => dispatch(model.cancelCommand()));
	return () => {
		const state = model.state;
		if (!state) {
			approvals.replaceChildren();
			approvalNodes.clear();
			stop.hidden = true;
			return;
		}
		const pending = state.approvals.filter(
			(approval) => approval.state === "pending",
		);
		stop.hidden = !state.cancelRequestId;
		stop.disabled = !model.cancelCommand();
		setText(
			stop,
			state.cancelling
				? model.cancelFailed
					? "중단 다시 시도"
					: "중단 처리 중"
				: "중단",
		);
		error.hidden = !model.error;
		setText(error, model.error);
		const ids = new Set(pending.map((approval) => approval.id));
		for (const [id, node] of approvalNodes)
			if (!ids.has(id)) {
				if (node.contains(document.activeElement))
					element("message", HTMLTextAreaElement).focus();
				node.remove();
				approvalNodes.delete(id);
			}
		for (const approval of pending) {
			let node = approvalNodes.get(approval.id);
			if (!node) {
				node = document.createElement("article");
				node.className = "approval-request";
				const operation = state.tools.find(
					(tool) => tool.id === approval.toolRunId,
				);
				const title = document.createElement("strong");
				setText(title, `${toolLabel(operation?.name)} · 승인 필요`);
				const target = document.createElement("p");
				target.className = "approval-target";
				setText(
					target,
					approvalDescriptor(operation?.name ?? "", approval.inputJson),
				);
				const exact = document.createElement("details");
				exact.className = "approval-input";
				const exactSummary = document.createElement("summary");
				exactSummary.textContent = "상세 내용";
				const input = document.createElement("pre");
				input.textContent = approval.inputJson;
				exact.append(exactSummary, input);
				const buttons = document.createElement("div");
				buttons.className = "approval-buttons";
				for (const [decision, label] of [
					["allow", "허용"],
					["deny", "거절"],
				] as const) {
					const button = document.createElement("button");
					button.type = "button";
					button.textContent = label;
					button.setAttribute("data-decision", decision);
					button.addEventListener("click", () => {
						dispatch(model.approvalCommand(approval.id, decision));
						element("message", HTMLTextAreaElement).focus();
					});
					buttons.append(button);
				}
				node.append(title, target, exact, buttons);
				approvals.append(node);
				approvalNodes.set(approval.id, node);
				queueMicrotask(() => {
					if (buttons.isConnected) buttons.scrollIntoView({ block: "nearest" });
				});
			}
			for (const button of node.querySelectorAll<HTMLButtonElement>(
				".approval-buttons button",
			))
				button.disabled = !model.approvalCommand(
					approval.id,
					button.getAttribute("data-decision") === "allow" ? "allow" : "deny",
				);
		}
	};
}
