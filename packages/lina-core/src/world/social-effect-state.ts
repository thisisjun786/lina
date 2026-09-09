import { finite, revision } from "./life-json.ts";
import { socialRecord } from "./social-checkpoint-validation.ts";
import { decodeSocialValue } from "./social-codec.ts";
import type {
	CompiledSocialPredicate,
	EnsembleCheckpoint,
	SocialCondition,
	SocialPredicateEffect,
	SocialResolveInput,
} from "./social-types.ts";
import { socialPredicateCategory } from "./social-views.ts";

export type BoundSocialWrite = Pick<
	SocialPredicateEffect,
	"predicateId" | "operator" | "value"
> & { first: string; second: string | null };
export type BoundSocialCondition = Pick<
	SocialCondition,
	"predicateId" | "operator" | "value" | "window"
> & { first: string; second: string | null };
type Cell = {
	value: number | boolean;
	duration: number | null;
	durationPresent: boolean;
	id: number;
	time: number;
	active: boolean;
	isActive: unknown;
	origin: unknown;
};
export const socialCellKey = (
	predicate: string,
	first: string,
	second: string | null,
): string => JSON.stringify([predicate, first, second]);

/** Independently interprets Lina's finite predicate grammar; never executes upstream source. */
export function createSocialEffectState(input: SocialResolveInput) {
	const pack = input.rulePack,
		predicates = new Map(pack.predicates.map((p) => [p.id, p]));
	const categories = new Map(
		pack.predicates.map((p) => [socialPredicateCategory(p.id), p.id]),
	);
	let operations = 0,
		bindings = 0;
	const tick = () => {
		if (++operations > input.limits.maxOperations)
			throw Error("Social effect replay operation budget exceeded");
	};
	const bindingTick = () => {
		tick();
		if (++bindings > input.limits.maxBindings)
			throw Error("Social effect replay binding budget exceeded");
	};
	const definition = (id: string): CompiledSocialPredicate => {
		const p = predicates.get(id);
		if (!p) throw Error("Unknown replay predicate");
		return p;
	};
	const frames: Map<string, Cell>[] = [];
	const previous =
		input.checkpoint.engineId === "ensemble" ? input.checkpoint.data : null;
	let counter = previous?.state.iterators["socialRecords"] ?? 0,
		step = previous?.state.step ?? 0;
	if (previous) {
		const history = decodeSocialValue(previous.state.history);
		if (!Array.isArray(history)) throw Error("Invalid replay history");
		for (const rawFrame of history) {
			if (!Array.isArray(rawFrame)) throw Error("Invalid replay frame");
			const frame = new Map<string, Cell>();
			for (const raw of rawFrame) {
				const row = socialRecord(raw),
					id = categories.get(String(row["category"]));
				if (!id) throw Error("Unknown replay history predicate");
				frame.set(
					socialCellKey(
						id,
						String(row["first"]),
						typeof row["second"] === "string" ? row["second"] : null,
					),
					{
						value: row["value"] as number | boolean,
						duration:
							typeof row["duration"] === "number" ? row["duration"] : null,
						durationPresent: Object.hasOwn(row, "duration"),
						id: Number(row["id"]),
						time: Number(row["timeHappened"]),
						active: row["isActive"] !== false,
						isActive: row["isActive"],
						origin: row["origin"],
					},
				);
			}
			frames.push(frame);
		}
	} else frames.push(new Map());
	function current(): Map<string, Cell> {
		const frame = frames[step];
		if (!frame) throw Error("Missing replay frame");
		return frame;
	}
	function read(
		id: string,
		first: string,
		second: string | null,
	): number | boolean {
		return (
			current().get(socialCellKey(id, first, second))?.value ??
			definition(id).initial
		);
	}
	function write(effect: BoundSocialWrite, origin?: string): void {
		tick();
		const p = definition(effect.predicateId),
			key = socialCellKey(p.id, effect.first, effect.second),
			cell = current().get(key);
		const before = cell?.value ?? p.initial;
		if (origin !== "lina-bootstrap" && p.policy.attitudeAxisId !== null) {
			const profile = input.identity.profiles.find(
				(p) => p.agentId === effect.first,
			);
			const changes =
				effect.operator === "=" ? effect.value !== before : effect.value !== 0;
			if (
				!profile ||
				(changes &&
					(profile.evolution !== "adaptive" ||
						profile.lockedAttitudeIds.includes(p.policy.attitudeAxisId)))
			)
				throw Error("Social identity axis locked");
		}
		let value = effect.value;
		if (effect.operator !== "=") {
			if (typeof before !== "number" || typeof value !== "number")
				throw Error("Invalid replay arithmetic");
			value = effect.operator === "+" ? before + value : before - value;
		}
		if (typeof value === "number")
			value = finite(
				Math.max(
					p.min ?? -Number.MAX_SAFE_INTEGER,
					Math.min(p.max ?? Number.MAX_SAFE_INTEGER, value),
				),
			);
		if (typeof value !== p.type) throw Error("Invalid replay value type");
		current().set(key, {
			value,
			duration: p.policy.duration,
			durationPresent: true,
			id: revision(++counter, 1),
			time: step,
			active: cell?.active ?? true,
			isActive: cell?.isActive,
			origin: cell ? cell.origin : origin,
		});
		if (p.direction === "reciprocal") {
			if (effect.second === null)
				throw Error("Missing reciprocal replay target");
			const reverse = socialCellKey(p.id, effect.second, effect.first),
				prior = current().get(reverse),
				id = revision(++counter, 1);
			// The pinned setter consumes a reverse ID even when it updates an existing row.
			current().set(reverse, {
				value,
				duration: p.policy.duration,
				durationPresent: true,
				id: prior?.id ?? id,
				time: step,
				active: prior?.active ?? true,
				isActive: prior?.isActive,
				origin: prior ? prior.origin : origin,
			});
		}
	}
	if (!previous)
		for (const p of pack.predicates)
			for (const first of pack.cast) {
				const seconds =
					p.direction === "undirected"
						? [null]
						: pack.cast
								.filter((c) => c.agentId !== first.agentId)
								.map((c) => c.agentId);
				for (const second of seconds) {
					if (
						p.direction === "reciprocal" &&
						second !== null &&
						second < first.agentId
					)
						continue;
					const mapped =
						p.policy.attitudeAxisId === null
							? undefined
							: input.life.attitudes.find(
									(a) =>
										a.axisId === p.policy.attitudeAxisId &&
										a.fromAgentId === first.agentId &&
										a.toAgentId === second,
								)?.value;
					write(
						{
							predicateId: p.id,
							first: first.agentId,
							second,
							operator: "=",
							value: mapped ?? p.initial,
						},
						"lina-bootstrap",
					);
				}
			}
	function compare(
		value: number | boolean,
		condition: BoundSocialCondition,
	): boolean {
		return condition.operator === "="
			? value === condition.value
			: typeof value === "number" &&
					typeof condition.value === "number" &&
					(condition.operator === ">"
						? value > condition.value
						: value < condition.value);
	}
	function condition(c: BoundSocialCondition): boolean {
		tick();
		const p = definition(c.predicateId),
			key = socialCellKey(p.id, c.first, c.second);
		let oldest = Math.max(0, step - (c.window?.leastRecent ?? 0));
		const newest = step - (c.window?.mostRecent ?? 0);
		if (previous) {
			const introductions = [
				previous.predicateIntroductions.find((i) => i.id === p.id),
				previous.agentIntroductions.find((i) => i.id === c.first),
				...(c.second === null
					? []
					: [previous.agentIntroductions.find((i) => i.id === c.second)]),
			];
			if (introductions.some((i) => i === undefined)) return false;
			oldest = Math.max(
				oldest,
				...introductions.map((i) => i?.socialStep ?? 0),
			);
			if (newest < oldest) return false;
		}
		if (newest < oldest) return false;
		for (let time = Math.max(0, oldest); time <= newest; time++) {
			tick();
			const frame = frames[time];
			if (!frame) continue;
			const cell = frame.get(key);
			if (compare(cell?.active ? cell.value : p.initial, c)) return true;
		}
		return false;
	}
	function advance(): void {
		const next = new Map<string, Cell>();
		for (const [key, cell] of current()) {
			tick();
			const copy = { ...cell };
			if (typeof copy.value === "boolean" && copy.duration !== null) {
				copy.duration--;
				if (copy.duration <= 0) {
					copy.duration = null;
					copy.durationPresent = false;
					if (copy.value !== false) {
						copy.value = false;
						copy.time = step + 1;
					}
				}
			}
			next.set(key, copy);
		}
		frames.push(next);
		step++;
	}
	function validate(checkpoint: EnsembleCheckpoint): void {
		const history = decodeSocialValue(checkpoint.data.state.history);
		if (
			!Array.isArray(history) ||
			history.length !== frames.length ||
			checkpoint.data.state.iterators["socialRecords"] !== counter
		)
			throw Error("Social replay history or write count mismatch");
		// Old frames were already compared losslessly by the transition guard. Bootstrap has no prior receipt.
		for (let time = previous ? step : 0; time <= step; time++) {
			const rows = history[time],
				frame = frames[time];
			if (!Array.isArray(rows) || !frame || rows.length !== frame.size)
				throw Error("Social replay history cell count mismatch");
			const expected = [...frame.entries()];
			for (let index = 0; index < rows.length; index++) {
				tick();
				const row = socialRecord(rows[index]),
					pair = expected[index],
					id = categories.get(String(row["category"]));
				if (
					!pair ||
					!id ||
					row["type"] !== "value" ||
					pair[0] !==
						socialCellKey(
							id,
							String(row["first"]),
							typeof row["second"] === "string" ? row["second"] : null,
						)
				)
					throw Error("Social replay history order mismatch");
				const cell = pair[1];
				if (
					row["value"] !== cell.value ||
					row["id"] !== cell.id ||
					row["timeHappened"] !== cell.time ||
					(row["duration"] ?? null) !== cell.duration ||
					Object.hasOwn(row, "duration") !== cell.durationPresent ||
					row["isActive"] !== cell.isActive ||
					row["origin"] !== cell.origin
				)
					throw Error("Social replay value or history metadata mismatch");
			}
		}
	}
	return {
		tick,
		bindingTick,
		read,
		write,
		condition,
		advance,
		definition,
		validate,
	};
}

export type SocialEffectState = ReturnType<typeof createSocialEffectState>;
