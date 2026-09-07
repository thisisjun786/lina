export type TaskApproval = {
	id: string;
	method: string;
	params: unknown;
	createdAt: string;
};

export type ApprovalDecision =
	| "accept"
	| "decline"
	| "cancel"
	| "acceptForSession";

export type TaskRecord = {
	id: string;
	threadId: string | null;
	ownerAgentId: string;
	title: string;
	cwd: string;
	status: string;
	revision: number;
	updatedAt: string;
	model: string | null;
	pendingApprovals: TaskApproval[];
};

export function taskStatusLabel(status: string): string {
	if (status === "inProgress" || status === "running") return "진행 중";
	if (status === "waiting_approval") return "확인 대기";
	if (status === "waiting_input") return "입력 대기";
	if (status === "needs_attention") return "확인 필요";
	if (status === "creating") return "만드는 중";
	if (status === "completed") return "완료";
	if (status === "interrupted") return "중단됨";
	if (status === "failed") return "실패";
	if (status === "queued" || status === "idle") return "대기";
	return status;
}
