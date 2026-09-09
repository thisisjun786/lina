import type { z } from "zod";
import type {
	createSchema,
	refSchema,
	resourceSchema,
	scopeSchema,
	updateSchema,
	versionSchema,
} from "./codec.ts";
export type ResourceScope = z.infer<typeof scopeSchema>;
export type Resource = z.infer<typeof resourceSchema>;
export type ResourceVersion = z.infer<typeof versionSchema>;
export type ResourceVersionRef = z.infer<typeof refSchema>;
export type ResourceCreate = z.input<typeof createSchema>;
export type ResourceUpdate = z.input<typeof updateSchema>;
