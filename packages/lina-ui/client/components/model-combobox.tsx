import { type Ref, useImperativeHandle, useRef, useState } from "react";
import type { ModelChoice } from "../model-combobox-types.ts";
import {
	Combobox,
	ComboboxContent,
	ComboboxEmpty,
	ComboboxInput,
	ComboboxItem,
	ComboboxList,
} from "./ui/combobox.tsx";

interface Selection {
	items: ModelChoice[];
	value: string;
	label: string;
	disabled: boolean;
}
export interface ModelComboboxHandle {
	input: HTMLInputElement | null;
	set(selection: Selection): void;
	disable(disabled: boolean): void;
	close(): void;
}

const normalize = (text: string) =>
	text.trim().replace(/\s+/g, " ").toLocaleLowerCase();
function matches(item: ModelChoice, query: string) {
	const text = normalize(`${item.label} ${item.search ?? ""}`);
	return normalize(query)
		.split(" ")
		.every((part) => text.includes(part));
}

export function ModelCombobox({
	id,
	label,
	onChange,
	ref,
}: {
	id: string;
	label: string;
	onChange(value: string): void;
	ref: Ref<ModelComboboxHandle>;
}) {
	const input = useRef<HTMLInputElement>(null);
	const [selection, setSelection] = useState<Selection>({
		items: [],
		value: "",
		label: "모델 선택…",
		disabled: false,
	});
	const [open, setOpen] = useState(false);
	const [query, setQuery] = useState<string | null>(null);
	const close = () => {
		setOpen(false);
		setQuery(null);
	};
	useImperativeHandle(ref, () => ({
		input: input.current,
		set(next) {
			setSelection(next);
			if (next.disabled) close();
		},
		disable(disabled) {
			setSelection((current) => ({ ...current, disabled }));
			if (disabled) close();
		},
		close,
	}));
	// Retain catalog order until searching; concrete models precede inheritance matches.
	const items = query?.trim()
		? [...selection.items].sort(
				(a, b) => Number(!!a.inherited) - Number(!!b.inherited),
			)
		: selection.items;
	const dialog = input.current?.closest("dialog");
	return (
		<Combobox
			items={items}
			filter={matches}
			value={{ value: selection.value, label: selection.label }}
			isItemEqualToValue={(item, value) => item.value === value.value}
			inputValue={query ?? selection.label}
			onInputValueChange={(value, details) => {
				if (details.reason === "input-change") setQuery(value);
			}}
			onValueChange={(item) => {
				// Editing the query must not clear the model or select inheritance.
				if (!item) return;
				setSelection((current) => ({
					...current,
					value: item.value,
					label: item.label,
				}));
				onChange(item.value);
			}}
			open={open}
			onOpenChange={(nextOpen) => {
				setOpen(nextOpen);
				if (!nextOpen) setQuery(null);
			}}
			disabled={selection.disabled}
		>
			<ComboboxInput
				ref={input}
				id={`${id}-input`}
				aria-label={label}
				title={selection.label}
				placeholder="모델 검색…"
			/>
			<ComboboxContent
				container={dialog}
				collisionBoundary={dialog ?? undefined}
			>
				<ComboboxEmpty id={`${id}-empty`}>
					<p className="agent-hint">검색 결과가 없습니다.</p>
				</ComboboxEmpty>
				<ComboboxList
					id={`${id}-list`}
					className="model-combobox-list"
					aria-label={`${label} 목록`}
				>
					{(item: ModelChoice) => (
						<ComboboxItem key={item.value} value={item}>
							{item.label}
						</ComboboxItem>
					)}
				</ComboboxList>
			</ComboboxContent>
		</Combobox>
	);
}
