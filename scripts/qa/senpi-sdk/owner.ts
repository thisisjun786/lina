import { Database } from "bun:sqlite";
import { join } from "node:path";
import { z } from "zod";

const receiptSchema = z.object({ operationId: z.string(), result: z.string() });
export const ownerSchema = z.object({
	attempts: z.array(
		receiptSchema.extend({ applied: z.number().int().min(0).max(1) }),
	),
	effects: z.array(receiptSchema),
	receipts: z.array(receiptSchema),
});

export function initializeOwner(root: string) {
	using db = new Database(join(root, "owner.sqlite"), {
		create: true,
		strict: true,
	});
	db.exec(`PRAGMA synchronous=FULL;
		CREATE TABLE receipts (operationId TEXT PRIMARY KEY, result TEXT NOT NULL);
		CREATE TABLE effects (operationId TEXT NOT NULL, result TEXT NOT NULL);
		CREATE TABLE attempts (operationId TEXT NOT NULL, result TEXT NOT NULL, applied INTEGER NOT NULL);`);
}

// The effect is a row in this owner's database, not an external product side effect.
// Receipt + effect + attempt commit atomically. No SDK guarantee is attributed to this transaction.
export function applyEffect(
	root: string,
	operation: z.infer<typeof receiptSchema>,
	fenced: boolean,
) {
	using db = new Database(join(root, "owner.sqlite"), { strict: true });
	db.exec("PRAGMA synchronous=FULL");
	return db
		.transaction(() => {
			const previous = db
				.query("SELECT operationId, result FROM receipts WHERE operationId = ?")
				.get(operation.operationId);
			const receipt = previous ? receiptSchema.parse(previous) : operation;
			const applied = fenced && previous ? 0 : 1;
			if (applied)
				db.query("INSERT INTO effects VALUES (?, ?)").run(
					operation.operationId,
					receipt.result,
				);
			db.query("INSERT INTO receipts VALUES (?, ?) ON CONFLICT DO NOTHING").run(
				operation.operationId,
				receipt.result,
			);
			db.query("INSERT INTO attempts VALUES (?, ?, ?)").run(
				operation.operationId,
				receipt.result,
				applied,
			);
			return { ...receipt, applied };
		})
		.immediate();
}

export function readOwner(root: string) {
	using db = new Database(join(root, "owner.sqlite"), {
		readonly: true,
		strict: true,
	});
	return ownerSchema.parse({
		attempts: db.query("SELECT * FROM attempts ORDER BY rowid").all(),
		effects: db.query("SELECT * FROM effects ORDER BY rowid").all(),
		receipts: db.query("SELECT * FROM receipts ORDER BY rowid").all(),
	});
}
