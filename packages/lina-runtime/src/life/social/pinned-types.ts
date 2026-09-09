export type EnginePredicate = {
	category: string;
	type: string;
	first: string;
	second?: string | undefined;
	value?: number | boolean | undefined;
	operator?: "=" | "+" | "-" | ">" | "<";
	intentType?: boolean;
	weight?: number;
	turnsAgoBetween?: [number, number];
	origin?: string;
};
export type EngineAction = {
	name: string;
	effects: EnginePredicate[];
	isAccept?: boolean;
};
export type RawEnsembleState = {
	history: unknown;
	step: number;
	offstage: string[];
	eliminated: string[];
	iterators: Record<string, number>;
	noRepeat: Record<string, number>;
	volitionCache: unknown;
	cachePositions: Record<string, number>;
};
export type RootResolution = {
	action: EngineAction | null;
	bindings: Record<string, string | number>;
	candidateIds: string[];
};
export type EngineApi = {
	init(): void;
	loadSocialStructure(value: unknown): unknown;
	addCharacters(value: unknown): string[];
	addRules(value: unknown): unknown;
	addActions(value: unknown): unknown;
	addHistory(value: unknown): unknown;
	set(value: EnginePredicate): void;
	get(value: EnginePredicate): EnginePredicate[];
	doAction(action: EngineAction): void;
	calculateVolition(cast: string[]): {
		dump(): unknown;
		getFirst(first: string, second: string): EnginePredicate | undefined;
		getNext(first: string, second: string): EnginePredicate | undefined;
	};
	runTriggerRules(cast: string[]): unknown;
	setupNextTimeStep(step?: number): void;
	setCharacterOffstage(agent: string): void;
	setCharacterEliminated(agent: string): void;
	getCurrentTimeStep(): number;
};
export type PinnedEnsemble = {
	api: EngineApi;
	readState(): RawEnsembleState;
	writeState(state: RawEnsembleState): void;
	definitions(): unknown;
	evaluateConditions(conditions: EnginePredicate[]): boolean;
	resolveRoot(
		name: string,
		actor: string,
		target: string,
		accepted: boolean,
		weight: number,
		cast: string[],
		/** Capacity of the unique ID trace; never a candidate selection cutoff. */
		maxCandidateIds: number,
	): RootResolution;
};
export type EngineHooks = {
	random: () => number;
	fixedBinding?: (role: string) => string | undefined;
	tick?: (kind: "operation" | "binding") => void;
	bindingAllowed?: (bindings: Record<string, string | number>) => boolean;
	window?: (
		predicate: EnginePredicate,
		recent: number,
		old: number,
		step: number,
	) => [number, number] | null;
	beforeSet?: (predicate: EnginePredicate) => void;
	matched?: (rule: string) => void;
};
