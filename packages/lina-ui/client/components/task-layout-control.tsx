import { Button } from "./ui/button.tsx";

/** A secondary task action, separate from the global sidebar control. */
export function TaskLayoutControl({
	active,
	onToggle,
}: {
	active: boolean;
	onToggle(): void;
}) {
	return (
		<Button
			id="toggle-task-column"
			variant="secondary"
			type="button"
			aria-pressed={active}
			aria-controls="task-column"
			title={
				active
					? "작업을 원래 목록으로 돌려놓기"
					: "에이전트와 작업 목록을 함께 보기"
			}
			onClick={onToggle}
		>
			{active ? "나란히 보기 종료" : "나란히 보기"}
		</Button>
	);
}
