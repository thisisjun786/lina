import type {
	CatalogModel,
	ModelControl,
	ModelTrial,
} from "../../lina-runtime/src/models/port.ts";
import { resolveModelRoute } from "../../lina-runtime/src/models/routes.ts";
import type {
	ModelProfile,
	ModelRole,
	ModelSettings,
	ModelSettingsInput,
} from "../../lina-runtime/src/models/types.ts";
import { MODEL_ROLES } from "../../lina-runtime/src/models/types.ts";
import { agentRequest, type RequestFn } from "./agent-editor.ts";
import { createModelCombobox, type ModelChoice } from "./model-combobox.ts";

export { MODEL_ROLES };

/** The browser DOM and the structural test fixture share this small surface. */
export interface SettingsNode {
	id: string;
	className: string;
	type: string;
	min: string;
	max: string;
	step: string;
	value: string;
	checked?: boolean;
	disabled: boolean;
	textContent: string | null;
	append(...nodes: SettingsNode[]): void;
	replaceChildren(...nodes: SettingsNode[]): void;
	before(...nodes: SettingsNode[]): void;
	after(...nodes: SettingsNode[]): void;
	querySelectorAll(selector: string): Iterable<SettingsNode>;
	hidden: boolean;
	setAttribute(name: string, value: string): void;
	removeAttribute(name: string): void;
	contains(node: unknown): boolean;
	select?(): void;
	scrollIntoView?(options?: { block: "nearest" }): void;
	addEventListener(
		type: string,
		listener: (event: {
			key?: string;
			relatedTarget?: unknown;
			preventDefault(): void;
			stopPropagation(): void;
		}) => unknown,
	): void;
	checkValidity(): boolean;
	reportValidity(): boolean;
	focus(): void;
}
export interface SettingsDocument {
	location: { href: string };
	getElementById(id: string): SettingsNode | null;
	createElement(tag: string): SettingsNode;
}
function browserDocument(): SettingsDocument {
	const doc = (globalThis as { document?: SettingsDocument }).document;
	if (!doc) throw Error("Model settings require a document");
	return doc;
}

const REASONING_LEVELS = ["off", "low", "medium", "high"] as const;
const REASONING_LABELS = {
	off: "모델 기본값",
	low: "낮음",
	medium: "보통",
	high: "높음",
};
const TIER_LABELS = {
	quick: "빠름",
	standard: "표준",
	deep: "깊음",
	intensive: "집중",
};
const keyOf = (m: Pick<CatalogModel, "provider" | "id">) =>
	`${m.provider}/${m.id}`;
const modelLabel = (m: CatalogModel) =>
	`${m.name.trim() || m.id} · ${m.provider}`;
function profileLabel(p: ModelProfile, catalog: CatalogModel[]) {
	const item = catalog.find(
		(m) => m.provider === p.provider && m.id === p.model,
	);
	return `${item ? modelLabel(item) : `${p.model} · ${p.provider}`}${!item?.authenticated ? " (연결 확인 필요)" : ""}`;
}

export function installModelSettings(
	dialog: { open: boolean },
	doc: SettingsDocument = browserDocument(),
	request: RequestFn = agentRequest,
) {
	const find = (id: string) => {
		const n = doc.getElementById(id);
		if (!n) throw Error(`Missing interface element: ${id}`);
		return n;
	};
	const root = find("model-settings"),
		status = find("model-settings-status"),
		save = find("model-save"),
		reload = find("model-reload"),
		testProfile = find("model-test-profile"),
		prompt = find("model-test-prompt"),
		test = find("model-test"),
		result = find("model-test-result");
	root.after(status);
	const discard = doc.createElement("button");
	discard.type = "button";
	discard.className = "text-button";
	discard.textContent = "편집 취소";
	reload.after(discard);
	const model = createModelSettings(request);
	let generation = 0,
		loading = false,
		testing = false;
	let trialId = "";
	const trialCombo = createModelCombobox(
		doc,
		"model-trial",
		"연결 테스트 모델",
		(value) => {
			trialId = value;
			controls();
		},
	);
	testProfile.replaceChildren(trialCombo.root);
	const scope = doc.createElement("select");
	scope.id = "model-scope";
	scope.setAttribute("aria-label", "역할 설정 범위");
	const option = (value: string, text: string) => {
		const n = doc.createElement("option");
		n.value = value;
		n.textContent = text;
		return n;
	};
	scope.append(option("", "전체 에이전트"));
	const scopes = new Set<string>();
	const addScope = (id: string) => {
		if (!/^[a-z][a-z0-9-]{0,47}$/.test(id) || scopes.has(id)) return;
		scopes.add(id);
		scope.append(option(id, `${id} · 개별 역할`));
	};
	addScope(new URL(doc.location.href).searchParams.get("agent") ?? "lina");
	const scopeRow = doc.createElement("label");
	scopeRow.className = "model-role-row";
	const scopeTitle = doc.createElement("span");
	scopeTitle.textContent = "역할 설정 범위";
	scopeRow.append(scopeTitle, scope);
	const hint = doc.createElement("p");
	hint.className = "agent-hint model-availability-hint";
	hint.textContent =
		"대화 모델은 직접 선택하고, 내부 엔진의 모델과 추론 수준은 공통 처리 등급에서 정합니다.";
	const rowsRoot = doc.createElement("div");
	rowsRoot.className = "model-rows";
	const effective = doc.createElement("div");
	effective.id = "model-effective";
	effective.className = "model-effective";
	root.replaceChildren(scopeRow, hint, rowsRoot, effective);
	type RowRole = ModelRole | "default";
	const rows = new Map<
		RowRole,
		{
			combo: ReturnType<typeof createModelCombobox>;
			reason: SettingsNode;
			hint: SettingsNode;
		}
	>();
	const getProfile = (
		settings: ModelSettingsInput,
		role: RowRole,
		agent = scope.value,
	): ModelProfile | null => {
		if (role === "default")
			return (
				settings.profiles.find((p) => p.id === settings.defaultProfileId) ??
				null
			);
		return profileFor(
			{
				revision: model.snapshot?.settings.revision ?? 0,
				...settings,
			},
			role,
			agent || undefined,
		);
	};
	const routeOf = (
		settings: ModelSettingsInput,
		role: ModelRole,
		agent = scope.value,
	) => {
		try {
			return resolveModelRoute(
				{
					revision: model.snapshot?.settings.revision ?? 0,
					...settings,
				},
				role,
				agent || undefined,
			);
		} catch {
			return null;
		}
	};
	const desiredReason = (
		settings: ModelSettingsInput,
		role: RowRole,
	): ModelProfile["reasoning"] =>
		getProfile(settings, role)?.reasoning ?? "low";
	const bind = (settings: ModelSettingsInput, role: RowRole, id: string) => {
		if (role === "default") {
			settings.defaultProfileId = id || null;
			return;
		}
		if (role !== "conversation") return;
		if (scope.value) settings.agentRoles[scope.value] ??= {};
		const bindings = scope.value
			? settings.agentRoles[scope.value]
			: settings.roles;
		if (!bindings) return;
		if (id) bindings[role] = id;
		else delete bindings[role];
	};
	const ensureProfile = (
		settings: ModelSettingsInput,
		item: CatalogModel,
		reason: ModelProfile["reasoning"],
		source?: ModelProfile | null,
	) => {
		const reasoning = item.reasoning ? reason : "off";
		const limit =
			source?.provider === item.provider && source.model === item.id
				? source.maxOutputTokens
				: undefined;
		const existing = settings.profiles.find(
			(p) =>
				p.provider === item.provider &&
				p.model === item.id &&
				p.reasoning === reasoning &&
				p.maxOutputTokens === limit,
		);
		if (existing) return existing;
		let index = 1;
		while (settings.profiles.some((p) => p.id === `profile-${index}`)) index++;
		const next: ModelProfile = {
			id: `profile-${index}`,
			provider: item.provider,
			model: item.id,
			reasoning,
			...(limit !== undefined ? { maxOutputTokens: limit } : {}),
		};
		settings.profiles.push(next);
		return next;
	};
	const controls = () => {
		save.disabled = loading || model.saving || !model.dirty;
		reload.disabled = loading || model.saving || testing;
		discard.disabled = loading || model.saving || testing || !model.dirty;
		test.disabled = loading || testing || !trialId;
		for (const [role, row] of rows)
			row.combo.disable(
				loading || (role !== "default" && role !== "conversation"),
			);
	};
	const changed = () => {
		render();
		status.textContent = model.dirty ? "저장 전 변경 사항" : "";
	};
	for (const role of ["default", ...MODEL_ROLES] as const) {
		const label = role === "default" ? "전역 기본값" : ROLE_LABELS[role];
		const row = doc.createElement("div");
		row.className = "model-config-row";
		row.id = `model-${role}-row`;
		const title = doc.createElement("label");
		title.textContent = label;
		title.setAttribute("for", `model-${role}-input`);
		const combo = createModelCombobox(
			doc,
			`model-${role}`,
			`${label} 모델`,
			(value) => {
				if (loading || !model.draft) return;
				if (role !== "default" && role !== "conversation") return;
				if (!value) {
					const draft = model.draft;
					const bound =
						role === "default"
							? draft.defaultProfileId
							: scope.value
								? draft.agentRoles[scope.value]?.[role]
								: draft.roles[role];
					if (!bound) return;
					model.edit((s) => bind(s, role, ""));
					changed();
					return;
				}
				const item = model.snapshot?.catalog.find(
					(m) =>
						m.authenticated && keyOf(m) === value && modelSupportsRole(m, role),
				);
				if (!item) return;
				model.edit((s) => {
					const previous = getProfile(s, role);
					const p = ensureProfile(
						s,
						item,
						role === "default" ? (previous?.reasoning ?? "low") : "low",
						previous,
					);
					bind(s, role, p.id);
				});
				changed();
			},
		);
		const reason = doc.createElement("select");
		reason.id = `model-${role}-reasoning`;
		reason.setAttribute("aria-label", `${label} 추론 수준`);
		for (const level of REASONING_LEVELS)
			reason.append(option(level, REASONING_LABELS[level]));
		reason.addEventListener("change", () => {
			const value = REASONING_LEVELS.find((v) => v === reason.value);
			if (!value || loading) return;
			if (
				role !== "default" &&
				!scope.value &&
				model.draft &&
				routeOf(model.draft, role)?.mode === "tier"
			)
				return;
			model.edit((s) => {
				if (role === "default") {
					const current = getProfile(s, role);
					const item = model.snapshot?.catalog.find(
						(m) => m.provider === current?.provider && m.id === current?.model,
					);
					if (item) bind(s, role, ensureProfile(s, item, value, current).id);
				} else if (scope.value) {
					s.agentRoleReasoning ??= {};
					const levels = s.agentRoleReasoning[scope.value] ?? {};
					s.agentRoleReasoning[scope.value] = levels;
					levels[role] = value;
				} else {
					s.roleReasoning ??= {};
					s.roleReasoning[role] = value;
				}
			});
			changed();
		});
		const rowHint = doc.createElement("p");
		rowHint.className = "model-row-hint";
		rowHint.id = `model-${role}-hint`;
		combo.input.setAttribute("aria-describedby", rowHint.id);
		row.append(title, combo.root, reason, rowHint);
		rowsRoot.append(row);
		rows.set(role, { combo, reason, hint: rowHint });
	}
	const render = () => {
		const snapshot = model.snapshot,
			draft = model.draft;
		if (!snapshot || !draft) {
			controls();
			return;
		}
		for (const item of snapshot.agents ?? []) addScope(item.id);
		for (const item of snapshot.active) addScope(item.agentId);
		for (const [role, row] of rows) {
			const current = getProfile(draft, role);
			const item = snapshot.catalog.find(
				(m) => m.provider === current?.provider && m.id === current?.model,
			);
			const ownId =
				role === "default"
					? draft.defaultProfileId
					: scope.value
						? draft.agentRoles[scope.value]?.[role]
						: draft.roles[role];
			const inherited = role !== "default" && !ownId;
			const route = role === "default" ? null : routeOf(draft, role);
			const inheritRoute = role === "default" ? null : routeOf(draft, role, "");
			const parent =
				role === "default" || inheritRoute?.mode === "tier"
					? null
					: scope.value
						? getProfile(draft, role, "")
						: draft.profiles.find((p) => p.id === draft.defaultProfileId);
			const inheritLabel =
				inheritRoute?.mode === "tier" && inheritRoute.tier
					? `등급 설정 사용 · ${TIER_LABELS[inheritRoute.tier]} · ${profileLabel(inheritRoute.profile, snapshot.catalog)}`
					: `${scope.value ? "전역 역할 설정 사용" : "전역 모델 사용"}${parent ? ` · ${profileLabel(parent, snapshot.catalog)}` : ""}`;
			const choices: ModelChoice[] = snapshot.catalog
				.filter((m) => m.authenticated && modelSupportsRole(m, role))
				.map((m) => ({
					value: keyOf(m),
					label: modelLabel(m),
					search: `${m.provider} ${m.id}`,
				}));
			if (role !== "default")
				choices.unshift({ value: "", label: inheritLabel, inherited: true });
			const shadowedByTier = role !== "default" && role !== "conversation";
			row.combo.set(
				choices,
				inherited || shadowedByTier
					? ""
					: item
						? keyOf(item)
						: current
							? `${current.provider}/${current.model}`
							: "",
				inherited || shadowedByTier
					? inheritLabel
					: current
						? profileLabel(current, snapshot.catalog)
						: "모델 선택…",
				loading || shadowedByTier,
			);
			row.reason.value =
				item && !item.reasoning ? "off" : desiredReason(draft, role);
			row.reason.disabled = loading || !item?.reasoning || shadowedByTier;
			row.hint.textContent =
				shadowedByTier && route?.tier
					? `실제 사용 모델은 ${TIER_LABELS[route.tier]} 등급 설정입니다.`
					: shadowedByTier
						? "공통 처리 등급 설정이 필요합니다."
						: role === "default"
							? "전체 에이전트에 공통으로 적용됩니다."
							: item && !item.reasoning
								? "이 모델은 추론 수준을 지원하지 않습니다."
								: "";
		}
		effective.replaceChildren();
		for (const item of snapshot.active.filter(
			(a) => !scope.value || a.agentId === scope.value,
		)) {
			const p = doc.createElement("p");
			const entry = snapshot.catalog.find(
				(m) => m.provider === item.provider && m.id === item.model,
			);
			p.textContent = `${item.agentId} 현재 대화: ${entry ? modelLabel(entry) : `${item.model} · ${item.provider}`} · ${item.settingsRevision === snapshot.settings.revision ? "적용됨" : "다음 대화부터 적용"}${item.error ? ` · ${item.error}` : ""}`;
			effective.append(p);
		}
		for (const role of MODEL_ROLES) {
			if (role === "conversation") continue;
			const route = routeOf(draft, role);
			if (route?.mode !== "tier" || !route.tier) continue;
			const line = doc.createElement("p");
			line.textContent = `${scope.value ? `${scope.value} ` : ""}${ROLE_LABELS[role]} 현재: ${profileLabel(route.profile, snapshot.catalog)} · ${TIER_LABELS[route.tier]} 등급`;
			effective.append(line);
		}
		const trialChoices = snapshot.settings.profiles
			.filter((p) =>
				snapshot.catalog.some(
					(m) =>
						m.authenticated && m.provider === p.provider && m.id === p.model,
				),
			)
			.map((p) => ({
				value: p.id,
				label: `${profileLabel(p, snapshot.catalog)} · ${REASONING_LABELS[p.reasoning]}`,
			}));
		if (!trialChoices.some((c) => c.value === trialId))
			trialId = trialChoices[0]?.value ?? "";
		trialCombo.set(
			trialChoices,
			trialId,
			trialChoices.find((c) => c.value === trialId)?.label ??
				"모델 설정을 먼저 저장하세요",
			loading || testing || !trialChoices.length,
		);
		controls();
	};
	const load = async (discardDraft = false) => {
		const mine = ++generation;
		loading = true;
		controls();
		status.textContent = "모델 목록을 불러오는 중…";
		try {
			const snapshot = await model.load(discardDraft);
			if (!snapshot || mine !== generation || !dialog.open) return;
			render();
			status.textContent = model.dirty ? "편집 내용을 유지했습니다." : "";
		} catch (error) {
			if (mine === generation && dialog.open)
				status.textContent =
					error instanceof Error
						? error.message
						: "목록을 불러오지 못했습니다.";
		} finally {
			if (mine === generation) {
				loading = false;
				render();
			}
		}
	};
	scope.addEventListener("change", () => {
		for (const row of rows.values()) row.combo.close();
		render();
	});
	save.addEventListener("click", async () => {
		if (save.disabled) return;
		const mine = generation;
		try {
			const pending = model.save();
			controls();
			status.textContent = "저장 중…";
			const saved = await pending;
			if (!saved || mine !== generation || !dialog.open) return;
			render();
			status.textContent = model.dirty
				? "저장됨 · 이후 편집 내용은 아직 저장되지 않았습니다."
				: "저장했습니다. 다음 대화부터 적용됩니다.";
		} catch (error) {
			if (mine === generation && dialog.open)
				status.textContent =
					error instanceof Error ? error.message : "저장하지 못했습니다.";
		} finally {
			if (mine === generation) controls();
		}
	});
	reload.addEventListener("click", () => load());
	discard.addEventListener("click", () => load(true));
	test.addEventListener("click", async () => {
		if (test.disabled) return;
		const mine = generation;
		testing = true;
		controls();
		result.textContent = "격리된 모델 테스트 중…";
		try {
			const trial = await model.test(trialId, prompt.value);
			if (trial && mine === generation && dialog.open)
				result.textContent = `${trial.provider} / ${trial.model} · ${trial.durationMs}ms · 입력 ${trial.inputTokens} / 출력 ${trial.outputTokens} 토큰\n${trial.text}`;
		} catch (error) {
			if (mine === generation && dialog.open)
				result.textContent =
					error instanceof Error
						? error.message
						: "테스트를 완료하지 못했습니다.";
		} finally {
			if (mine === generation) {
				testing = false;
				controls();
			}
		}
	});
	return {
		refresh() {
			return load();
		},
		open(agentId = "") {
			addScope(agentId);
			scope.value = agentId;
			return load();
		},
		close() {
			generation++;
			model.close();
			loading = false;
			testing = false;
			for (const row of rows.values()) row.combo.close();
			trialCombo.close();
		},
	};
}
export type ModelsResponse = {
	agents?: Array<{ id: string; name: string }>;
	settings: ModelSettings;
	catalog: CatalogModel[];
	active: Array<ReturnType<ModelControl["state"]> & { agentId: string }>;
};
export const ROLE_LABELS: Record<ModelRole, string> = {
	conversation: "대화",
	summary: "요약",
	observation: "관찰",
	reflection: "성찰",
	recall: "기억 검색",
	vision: "비전",
};
export function modelSupportsRole(
	model: CatalogModel,
	role: ModelRole | "default",
): boolean {
	if (role === "vision" && !model.imageInput) return false;
	const roles = model.supportedRoles;
	if (!roles) return true;
	const needed = role === "default" ? "conversation" : role;
	return roles.includes(needed);
}
export function profileFor(
	settings: ModelSettings,
	role: ModelRole,
	agentId?: string,
): ModelProfile | null {
	try {
		return resolveModelRoute(settings, role, agentId)?.profile ?? null;
	} catch {
		return null;
	}
}
export function settingsInput(settings: ModelSettings): ModelSettingsInput {
	const { revision: _revision, ...input } = settings;
	return structuredClone(input);
}
export function createProfile(
	model: CatalogModel,
	profiles: ModelProfile[],
	reasoning: ModelProfile["reasoning"],
	output: number,
): ModelProfile {
	let index = 1;
	while (profiles.some((profile) => profile.id === `profile-${index}`)) index++;
	const limit = Math.min(model.maxOutputTokens, model.contextWindow, 1_048_576);
	if (!Number.isSafeInteger(limit) || limit < 1 || !Number.isFinite(output))
		throw Error("모델의 출력 한도를 확인해주세요.");
	return {
		id: `profile-${index}`,
		provider: model.provider,
		model: model.id,
		reasoning: model.reasoning ? reasoning : "off",
		maxOutputTokens: Math.max(1, Math.min(limit, Math.floor(output))),
	};
}

/** Drafts stay separate from server receipts; closing fences every async completion. */
export function createModelSettings(request: RequestFn = agentRequest) {
	let generation = 0;
	let edits = 0;
	let controller: AbortController | undefined;
	let loaded: ModelsResponse | undefined;
	let draft: ModelSettingsInput | undefined;
	let saving = false;
	const load = async (discardDraft = false) => {
		const mine = ++generation;
		controller?.abort();
		controller = new AbortController();
		saving = false;
		try {
			const value = (await request(
				"/api/models",
				"GET",
				undefined,
				controller.signal,
			)) as ModelsResponse;
			if (mine !== generation) return undefined;
			const dirty =
				loaded &&
				draft &&
				JSON.stringify(draft) !==
					JSON.stringify(settingsInput(loaded.settings));
			if (!dirty || discardDraft) {
				loaded = value;
				draft = settingsInput(value.settings);
			} else if (loaded) loaded = { ...value, settings: loaded.settings };
			return loaded;
		} catch (error) {
			if (mine === generation) throw error;
			return undefined;
		}
	};
	const save = async (input = draft) => {
		if (!loaded || !input) throw Error("설정을 먼저 불러와주세요.");
		if (saving) throw Error("설정을 저장하는 중입니다.");
		const mine = generation;
		const editVersion = edits;
		const sent = structuredClone(input);
		saving = true;
		try {
			const value = (await request(
				"/api/models/settings",
				"PATCH",
				{ revision: loaded.settings.revision, settings: sent },
				controller?.signal,
			)) as { settings: ModelSettings };
			if (mine !== generation) return undefined;
			loaded = { ...loaded, settings: value.settings };
			if (editVersion === edits) draft = settingsInput(value.settings);
			return value.settings;
		} catch (error) {
			if (mine === generation) throw error;
			return undefined;
		} finally {
			if (mine === generation) saving = false;
		}
	};
	const test = async (profileId: string, prompt: string) => {
		if (!prompt.trim()) throw Error("테스트 문장을 입력해주세요.");
		if (!loaded?.settings.profiles.some((profile) => profile.id === profileId))
			throw Error("프로필을 먼저 저장해주세요.");
		const mine = generation;
		try {
			const trial = (await request(
				"/api/models/test",
				"POST",
				{ profileId, prompt },
				controller?.signal,
			)) as ModelTrial;
			return mine === generation ? trial : undefined;
		} catch (error) {
			if (mine === generation) throw error;
			return undefined;
		}
	};
	return {
		load,
		save,
		test,
		edit(change: (input: ModelSettingsInput) => void) {
			if (!draft) return;
			const next = structuredClone(draft);
			change(next);
			draft = next;
			edits++;
		},
		get snapshot() {
			return loaded;
		},
		get draft() {
			return draft;
		},
		get saving() {
			return saving;
		},
		get dirty() {
			return (
				!!loaded &&
				!!draft &&
				JSON.stringify(draft) !== JSON.stringify(settingsInput(loaded.settings))
			);
		},
		close() {
			generation++;
			controller?.abort();
			saving = false;
		},
	};
}
