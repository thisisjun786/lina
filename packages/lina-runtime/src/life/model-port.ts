import type {
	LifeModelReconciliation,
	LifeModelRequest,
	LifeModelResult,
	PreparedLifeModelRequest,
} from "../../../lina-core/src/world/autonomy-types.ts";

/** Owned background Codex requests. Prepare and reconcile never call the configured provider. */
export interface LifeModelPort {
	prepare(
		request: LifeModelRequest,
		signal: AbortSignal,
	): Promise<PreparedLifeModelRequest>;
	complete(
		request: PreparedLifeModelRequest,
		signal: AbortSignal,
	): Promise<LifeModelResult>;
	reconcile(
		request: PreparedLifeModelRequest,
	): Promise<LifeModelReconciliation>;
	close(): Promise<void>;
}
