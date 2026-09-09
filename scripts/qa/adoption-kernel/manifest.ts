import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { decodePublicCase } from "./public-case.ts";
import type { BatchManifest } from "./scenario-export.ts";
import { BEHAVIOR_IDS, decodeTruth } from "./truth.ts";
export function loadManifest(path: string): BatchManifest {
	const value: unknown = JSON.parse(readFileSync(path, "utf8"));
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw Error("invalid manifest");
	const m = value as BatchManifest;
	if (
		Object.keys(m).sort().join() !==
			["version", "seed", "purpose", "episodes"].sort().join() ||
		m.version !== 1 ||
		typeof m.seed !== "string" ||
		!m.seed ||
		!["development", "qualification"].includes(m.purpose) ||
		!Array.isArray(m.episodes) ||
		!m.episodes.length
	)
		throw Error("invalid manifest fields");
	const ids = new Set<string>(),
		cases = new Set<string>();
	for (const e of m.episodes) {
		if (
			!e ||
			Object.keys(e).sort().join() !==
				[
					"episodeId",
					"row",
					"variant",
					"subcase",
					"publicPath",
					"truthPath",
					"publicHash",
					"truthHash",
				]
					.sort()
					.join()
		)
			throw Error("invalid episode fields");
		if (
			typeof e.episodeId !== "string" ||
			!e.episodeId ||
			ids.has(e.episodeId) ||
			!BEHAVIOR_IDS.includes(e.row) ||
			!Number.isInteger(e.variant) ||
			e.variant < 0 ||
			e.variant > 3
		)
			throw Error("invalid episode identity");
		ids.add(e.episodeId);
		const key = `${e.row}/${e.variant}/${e.subcase}`;
		if (cases.has(key)) throw Error("duplicate variant");
		cases.add(key);
		const texts: string[] = [];
		for (const [file, hash] of [
			[e.publicPath, e.publicHash],
			[e.truthPath, e.truthHash],
		]) {
			if (
				typeof file !== "string" ||
				typeof hash !== "string" ||
				!/^[a-f0-9]{64}$/.test(hash)
			)
				throw Error("invalid artifact reference");
			const text = readFileSync(file, "utf8").trim();
			if (createHash("sha256").update(text).digest("hex") !== hash)
				throw Error("artifact hash mismatch");
			texts.push(text);
		}
		const input = decodePublicCase(JSON.parse(texts[0] ?? "")),
			truth = decodeTruth(JSON.parse(texts[1] ?? ""));
		if (
			input.episodeId !== e.episodeId ||
			truth.episodeId !== e.episodeId ||
			truth.row !== e.row ||
			truth.variant !== e.variant ||
			truth.subcase !== e.subcase ||
			truth.seed !== m.seed ||
			truth.expected.finalStage >= input.stages.length
		)
			throw Error("public/private mapping mismatch");
	}
	if (m.purpose === "qualification") {
		if (m.episodes.length !== 64)
			throw Error("incomplete qualification manifest");
		for (const row of BEHAVIOR_IDS)
			for (let v = 0; v < 4; v++)
				for (const subcase of row === "B15" ? ["visible", "omitted"] : ["main"])
					if (!cases.has(`${row}/${v}/${subcase}`))
						throw Error("missing qualification case");
	}
	return structuredClone(m);
}
