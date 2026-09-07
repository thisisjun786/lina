import type { KeyboardEvent, PointerEvent } from "react";
import { useCallback, useEffect, useRef } from "react";
import type { AgentListRow } from "../../../lina-client/src/agent-list.ts";
import { Avatar } from "./ui/avatar.tsx";
import { Button } from "./ui/button.tsx";

export type AgentListActions = {
	select(id: string): void;
	menu(id: string, opener: HTMLElement): void;
	retry(): void;
};

const LONG_PRESS_MS = 550;
const PRESS_MOVE_TOLERANCE = 10;

function messageTime(timestamp: string | null): string {
	if (!timestamp) return "";
	const date = new Date(timestamp);
	if (!Number.isFinite(date.getTime())) return "";
	const today = new Date();
	if (date.toDateString() === today.toDateString())
		return date.toLocaleTimeString("ko-KR", {
			hour: "2-digit",
			minute: "2-digit",
			hour12: false,
		});
	today.setDate(today.getDate() - 1);
	return date.toDateString() === today.toDateString()
		? "어제"
		: date.toLocaleDateString("ko-KR", {
				month: "numeric",
				day: "numeric",
				...(date.getFullYear() !== today.getFullYear()
					? { year: "2-digit" }
					: {}),
			});
}

function AgentRow({
	row,
	actions,
	onNavigate,
	linkRef,
}: {
	row: AgentListRow;
	actions: AgentListActions;
	onNavigate(event: KeyboardEvent<HTMLButtonElement>): void;
	linkRef(node: HTMLButtonElement | null): void;
}) {
	const more = useRef<HTMLButtonElement>(null);
	const longPressed = useRef(false);
	const press = useRef<{
		timer: ReturnType<typeof setTimeout>;
		controller: AbortController;
		pointerId: number;
		x: number;
		y: number;
	} | null>(null);
	const cancelPress = useCallback(() => {
		if (!press.current) return;
		clearTimeout(press.current.timer);
		press.current.controller.abort();
		press.current = null;
	}, []);
	useEffect(() => cancelPress, [cancelPress]);
	const openMenu = () => {
		cancelPress();
		if (more.current) actions.menu(row.id, more.current);
	};
	const startPress = (event: PointerEvent<HTMLButtonElement>) => {
		cancelPress();
		longPressed.current = false;
		if (event.pointerType !== "touch" || !event.isPrimary) return;
		const controller = new AbortController();
		// Scroll events do not bubble. Capture also catches a scrollable ancestor.
		event.currentTarget.ownerDocument.addEventListener("scroll", cancelPress, {
			capture: true,
			signal: controller.signal,
		});
		press.current = {
			controller,
			pointerId: event.pointerId,
			x: event.clientX,
			y: event.clientY,
			timer: setTimeout(() => {
				longPressed.current = true;
				openMenu();
			}, LONG_PRESS_MS),
		};
	};
	const contextKeys = (event: KeyboardEvent<HTMLDivElement>) => {
		if (
			event.key === "ContextMenu" ||
			(event.shiftKey && event.key === "F10")
		) {
			event.preventDefault();
			openMenu();
		}
	};
	const time = messageTime(row.timestamp);
	const confirmation = (row.confirmationCount ?? 0) > 0;
	return (
		// The wrapper shares context-menu shortcuts between its two native buttons.
		// biome-ignore lint/a11y/noStaticElementInteractions: keyboard activation lives on the descendant buttons.
		<div
			className={`agent-row${row.selected ? " selected" : ""}${row.unread ? " unread" : ""}${confirmation ? " needs-confirmation" : ""}`}
			data-agent-id={row.id}
			onContextMenu={(event) => {
				event.preventDefault();
				openMenu();
			}}
			onKeyDown={contextKeys}
		>
			<Button
				ref={linkRef}
				type="button"
				className="agent-link"
				aria-current={row.selected}
				aria-label={`${row.name} · ${row.role} · ${row.preview}${row.unread ? " · 읽지 않은 메시지" : ""}${row.summaryUnavailable ? " · 요약 새로 고침 실패" : ""}${row.running ? " · 작업 중" : ""}`}
				onKeyDown={onNavigate}
				onPointerDown={startPress}
				onPointerMove={(event) => {
					const start = press.current;
					if (
						start &&
						event.pointerId === start.pointerId &&
						Math.hypot(event.clientX - start.x, event.clientY - start.y) >
							PRESS_MOVE_TOLERANCE
					)
						cancelPress();
				}}
				onPointerUp={cancelPress}
				onPointerCancel={cancelPress}
				onPointerLeave={cancelPress}
				onClick={() => {
					if (!longPressed.current) actions.select(row.id);
					longPressed.current = false;
				}}
			>
				<Avatar
					src={
						row.avatarId
							? `/api/avatars/${encodeURIComponent(row.avatarId)}`
							: undefined
					}
					fallback={Array.from(row.name.trim())[0] ?? "?"}
				/>
				<span className="agent-copy sidebar-label">
					<span className="agent-line">
						<strong title={row.name}>{row.name}</strong>
						<time dateTime={row.timestamp ?? ""} hidden={!time}>
							{time}
						</time>
					</span>
					<span className="agent-line">
						<small title={row.preview}>{row.preview}</small>
						<span
							className="agent-unread"
							aria-hidden="true"
							hidden={!row.unread}
						/>
						<span
							className="agent-working"
							aria-hidden="true"
							hidden={!row.running || confirmation || row.unread}
						>
							작업 중
						</span>
					</span>
				</span>
			</Button>
			<Button
				ref={more}
				type="button"
				className="agent-more sidebar-label"
				aria-label={`${row.name} · ${row.role} 메뉴`}
				aria-haspopup="menu"
				aria-controls="agent-actions"
				onClick={openMenu}
			>
				<svg viewBox="0 0 24 24" aria-hidden="true">
					{[5, 12, 19].map((x) => (
						<circle key={x} cx={x} cy="12" r="1" />
					))}
				</svg>
			</Button>
		</div>
	);
}

export function AgentList({
	rows,
	actions,
}: {
	rows: AgentListRow[];
	actions: AgentListActions;
}) {
	const links = useRef(new Map<string, HTMLButtonElement>());
	const navigate = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
		if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
		event.preventDefault();
		const next =
			event.key === "Home"
				? 0
				: event.key === "End"
					? rows.length - 1
					: Math.max(
							0,
							Math.min(
								rows.length - 1,
								index + (event.key === "ArrowDown" ? 1 : -1),
							),
						);
		const row = rows[next];
		if (row) links.current.get(row.id)?.focus();
	};
	return rows.map((row, index) => (
		<AgentRow
			key={row.id}
			row={row}
			actions={actions}
			onNavigate={(event) => navigate(event, index)}
			linkRef={(node) => {
				if (node) links.current.set(row.id, node);
				else links.current.delete(row.id);
			}}
		/>
	));
}

export function AgentListStatus({
	copy,
	retry,
	onRetry,
}: {
	copy: string;
	retry: boolean;
	onRetry(): void;
}) {
	return (
		<>
			<span>{copy}</span>
			<Button
				type="button"
				className="text-button"
				hidden={!retry}
				onClick={onRetry}
			>
				다시 시도
			</Button>
		</>
	);
}
