import type { Theme } from "../theme.ts";
import { Button } from "./ui/button.tsx";

const choices: { value: Theme; label: string }[] = [
	{ value: "dark", label: "다크" },
	{ value: "light", label: "라이트" },
	{ value: "system", label: "시스템" },
];

export function ThemeControlsView({
	preference,
	select,
}: {
	preference: Theme;
	select: (theme: Theme) => void;
}) {
	return (
		<>
			{choices.map(({ value, label }) => (
				<Button
					key={value}
					type="button"
					data-theme-choice={value}
					aria-pressed={value === preference}
					onClick={() => select(value)}
				>
					{label}
				</Button>
			))}
		</>
	);
}
