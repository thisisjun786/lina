/** Application receipt vocabulary; core does not depend on a task execution adapter. */
export type WorkOutcome =
	| "turn_ended"
	| "verified_result"
	| "failed"
	| "interrupted";
export interface WorkInfluenceRule {
	id: string;
	familyId: string;
	categoryId: string;
	outcomes: WorkOutcome[];
	attribution: "owner" | "participant";
	weight: number;
	requiredMatch: boolean;
}
export interface WorkConfig {
	rules: WorkInfluenceRule[];
}
