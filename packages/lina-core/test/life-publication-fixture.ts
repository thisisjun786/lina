import type { DatabaseSync } from "node:sqlite";
import { IMAGE_SCHEMA } from "../src/world/image-schema.ts";
import { PUBLICATION_SCHEMA } from "../src/world/publication-schema.ts";

/** Remove only the known publication delta while constructing a synthetic legacy file. */
export function stripPublicationFixture(db: DatabaseSync): void {
	// Current synthetic stores contain the later image owner; remove its empty tables before downgrading.
	const images = [
		...IMAGE_SCHEMA.matchAll(/CREATE TABLE (life_image_[a-z_]+) /g),
	].map((match) => match[1]);
	for (const table of images.reverse()) db.exec(`DROP TABLE ${table}`);
	const tables = [
		...PUBLICATION_SCHEMA.matchAll(/CREATE TABLE (life_publication_[a-z_]+) /g),
	].map((match) => match[1]);
	for (const table of tables.reverse()) db.exec(`DROP TABLE ${table}`);
}
