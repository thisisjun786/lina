import type { DatabaseSync } from "node:sqlite";

/** Fixture downgrade only. Does not claim the fixture was written by an old binary. */
export function removeReasoningSchema(db: DatabaseSync): void {
	db.exec(`
		DROP TABLE engine_premises;
		DROP TABLE engine_reasoning_receipts;
		DROP TABLE engine_reasoning_jobs;
		DROP TABLE engine_reasoning_checkpoint;
		DELETE FROM engine_meta WHERE key='reasoning_migration_revision';
		PRAGMA user_version=3;
	`);
}
