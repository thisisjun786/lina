import { existsSync, lstatSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import {
	checkedDirectory,
	fsyncDirectory,
	readRegular,
	writeExclusive,
} from "../../lina-core/src/attachments/filesystem.ts";
import { parseLifeModelResult } from "../../lina-core/src/world/autonomy-record-validation.ts";
import type {
	LifeModelReconciliation,
	PreparedLifeModelRequest,
} from "../../lina-core/src/world/autonomy-types.ts";
import { canonicalLifeJson } from "../../lina-core/src/world/life-json.ts";
import {
	LIFE_MAX_BYTES,
	LIFE_UNKNOWN_USAGE,
	lifeFields,
	lifeInteger,
	lifePrepared,
	lifeString,
	lifeUsage,
} from "./life-model-validation.ts";

export function lifeWrite(path: string, value: unknown): void {
	writeExclusive(path, Buffer.from(canonicalLifeJson(value)));
	fsyncDirectory(dirname(path));
}
function read(path: string): unknown {
	const info = lstatSync(path);
	if ((info.mode & 0o077) !== 0 || info.uid !== process.getuid?.())
		throw Error("LIFE journal ownership changed");
	return JSON.parse(
		Buffer.from(readRegular(path, LIFE_MAX_BYTES * 4)).toString("utf8"),
	);
}
export class LifeModelJournal {
	readonly directory: string;
	constructor(
		stateRoot: string,
		readonly prepared: PreparedLifeModelRequest,
		create = false,
	) {
		const parent = checkedDirectory(join(stateRoot, "life-model"), create);
		this.directory = join(
			parent,
			prepared.nativeReference.slice("life-model-".length),
		);
		checkedDirectory(this.directory, create);
		const info = lstatSync(this.directory);
		if ((info.mode & 0o077) !== 0 || info.uid !== process.getuid?.())
			throw Error("LIFE journal requires an owned private directory");
		const path = join(this.directory, "initial.json");
		if (create && !existsSync(path)) {
			if (readdirSync(this.directory).length)
				throw Error("LIFE journal root is not empty");
			lifeWrite(path, prepared);
			fsyncDirectory(parent);
			fsyncDirectory(dirname(parent));
		}
		const saved = lifePrepared(read(path));
		if (canonicalLifeJson(saved) !== canonicalLifeJson(prepared))
			throw Error("LIFE request conflicts with its owned journal");
	}
	write(name: string, value: unknown): void {
		lifeWrite(join(this.directory, `${name}.json`), value);
	}
	has(name: string): boolean {
		return existsSync(join(this.directory, `${name}.json`));
	}
	reconcile(): LifeModelReconciliation {
		this.checkMarkers();
		if (this.has("result")) {
			if (!this.has("outbound")) throw Error("Missing LIFE outbound marker");
			const result = parseLifeModelResult(
				read(join(this.directory, "result.json")),
				this.prepared,
			);
			const binding = lifeFields(read(join(this.directory, "binding.json")), [
				"threadId",
				"pid",
			]);
			if (
				binding["threadId"] !== result.threadId ||
				canonicalLifeJson(read(join(this.directory, "usage.json"))) !==
					canonicalLifeJson(result.usage)
			)
				throw Error("LIFE result does not match native transport evidence");
			return { status: "completed", result };
		}
		if (this.has("failure")) {
			const r = lifeFields(read(join(this.directory, "failure.json")), [
				"status",
				"usage",
				"upstreamAttempts",
				"reason",
			]);
			const usage = lifeUsage(r["usage"]);
			if (
				r["status"] !== "failed" ||
				r["upstreamAttempts"] !== (this.has("outbound") ? 1 : 0) ||
				(!this.has("dispatch") &&
					Object.values(usage).some((value) => value !== 0))
			)
				throw Error("Invalid LIFE failure journal");
			return {
				status: "failed",
				usage,
				upstreamAttempts: r["upstreamAttempts"] as 0 | 1,
				reason: lifeString(r["reason"], 1024),
			};
		}
		if (!this.has("dispatch") && !this.has("preflight"))
			return { status: "not_dispatched" };
		return {
			status: "unknown",
			usage: this.has("usage")
				? lifeUsage(read(join(this.directory, "usage.json")))
				: { ...LIFE_UNKNOWN_USAGE },
			upstreamAttempts: this.has("outbound") ? 1 : 0,
		};
	}
	private checkMarkers(): void {
		for (const entry of readdirSync(this.directory, { withFileTypes: true })) {
			if (
				(entry.isDirectory() &&
					(entry.name === "native" ||
						/^qualification-[0-9a-f-]{36}$/.test(entry.name))) ||
				(entry.isFile() &&
					[
						"initial.json",
						"preflight.json",
						"dispatch.json",
						"outbound.json",
						"failure.json",
						"result.json",
						"usage.json",
						"binding.json",
						"transport.json",
						"gateway.json",
					].includes(entry.name))
			)
				continue;
			throw Error("Unexpected LIFE journal entry");
		}
		for (const [name, last] of [
			["preflight", "pid"],
			["dispatch", "pid"],
			["outbound", "upstreamAttempts"],
		] as const) {
			if (!this.has(name)) continue;
			const marker = lifeFields(read(join(this.directory, `${name}.json`)), [
				"version",
				"requestId",
				"inputDigest",
				last,
			]);
			if (
				marker["version"] !== 1 ||
				marker["requestId"] !== this.prepared.request.id ||
				marker["inputDigest"] !== this.prepared.inputDigest
			)
				throw Error("Invalid LIFE dispatch ownership marker");
			lifeInteger(
				marker[last],
				1,
				last === "upstreamAttempts" ? 1 : Number.MAX_SAFE_INTEGER,
			);
		}
		if (
			(this.has("outbound") ||
				this.has("result") ||
				this.has("binding") ||
				this.has("transport") ||
				this.has("gateway") ||
				this.has("native")) &&
			!this.has("dispatch")
		)
			throw Error("Orphaned LIFE native record");
		if (this.has("failure") && !this.has("dispatch") && !this.has("preflight"))
			throw Error("Orphaned LIFE failure record");
		if (this.has("usage") && !this.has("outbound"))
			throw Error("Orphaned LIFE usage record");
		if (this.has("failure") && this.has("result"))
			throw Error("Conflicting LIFE native terminal records");
	}
}
