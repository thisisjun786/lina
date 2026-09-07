export type CheckpointErrorCode =
	| "invalid-input"
	| "duplicate-component"
	| "unsafe-path"
	| "source-changed"
	| "corrupt"
	| "target-exists"
	| "not-found"
	| "busy";

export class CheckpointError extends Error {
	constructor(
		readonly code: CheckpointErrorCode,
		message: string,
	) {
		super(message);
		this.name = "CheckpointError";
	}
}
