import { createRef, type ReactNode } from "react";
import { flushSync } from "react-dom";
import { mountView } from "./mount.ts";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
} from "./ui/dropdown-menu.tsx";

interface Action {
	id: string;
	label: string;
	icon?: ReactNode;
	shortcut?: string;
	run(opener: HTMLElement): void;
}

/** Existing controllers own triggers; this adapter owns the entire menu subtree. */
export function createActionMenu(options: {
	id: string;
	label: string;
	items: Action[];
	side?: "top" | "bottom";
	align?: "start" | "end";
}) {
	const host = document.createElement("div");
	host.dataset["uiHost"] = options.id;
	document.body.append(host);
	const view = mountView(host);
	const actionsRef = createRef<{ close(): void; unmount(): void }>();
	let anchor: HTMLElement | null = null;
	let opened = false;
	let restoreFocus = false;
	const render = () =>
		view.render(
			<DropdownMenu
				actionsRef={actionsRef}
				open={opened}
				modal={false}
				onOpenChange={(next, details) => {
					// The trigger belongs to the controller, so Base UI does not know it.
					// Let its click toggle once instead of outside-press closing then reopening.
					if (
						details.reason === "outside-press" &&
						details.event.target instanceof Node &&
						anchor?.contains(details.event.target)
					) {
						details.cancel();
						return;
					}
					if (!next) restoreFocus = details.reason === "escape-key";
					opened = next;
					anchor?.setAttribute("aria-expanded", String(next));
					render();
				}}
			>
				<DropdownMenuContent
					id={options.id}
					aria-label={options.label}
					anchor={anchor}
					side={options.side ?? "bottom"}
					align={options.align ?? "start"}
					onKeyDown={(event) => {
						if (event.key !== "Tab") return;
						// External triggers have no Base UI focus guard. Resume the
						// browser's native Tab/Shift+Tab order at the actual opener.
						close();
						flushSync(() => actionsRef.current?.unmount());
						if (anchor?.isConnected) anchor.focus({ preventScroll: true });
					}}
					finalFocus={() =>
						restoreFocus && anchor?.isConnected ? anchor : false
					}
				>
					{options.items.map((item) => (
						<DropdownMenuItem
							key={item.id}
							id={item.id}
							render={<button type="button" />}
							onClick={() => {
								const opener = anchor;
								close();
								if (opener) item.run(opener);
							}}
						>
							{item.icon}
							<span>{item.label}</span>
							{item.shortcut && <kbd>{item.shortcut}</kbd>}
						</DropdownMenuItem>
					))}
				</DropdownMenuContent>
			</DropdownMenu>,
		);
	function close() {
		restoreFocus = false;
		opened = false;
		anchor?.setAttribute("aria-expanded", "false");
		render();
	}
	function open(opener: HTMLElement, edge: "first" | "last" = "first") {
		anchor?.setAttribute("aria-expanded", "false");
		anchor = opener;
		opened = true;
		restoreFocus = false;
		opener.setAttribute("aria-haspopup", "menu");
		opener.setAttribute("aria-controls", options.id);
		opener.setAttribute("aria-expanded", "true");
		render();
		const item = edge === "first" ? options.items[0] : options.items.at(-1);
		if (item) document.getElementById(item.id)?.focus({ preventScroll: true });
	}
	const bindings: Array<() => void> = [];
	render();
	return {
		open,
		close,
		bindTrigger(trigger: HTMLElement) {
			const click = () => (opened ? close() : open(trigger));
			const keydown = (event: KeyboardEvent) => {
				if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
				event.preventDefault();
				open(trigger, event.key === "ArrowUp" ? "last" : "first");
			};
			trigger.addEventListener("click", click);
			trigger.addEventListener("keydown", keydown);
			bindings.push(() => {
				trigger.removeEventListener("click", click);
				trigger.removeEventListener("keydown", keydown);
			});
		},
		destroy() {
			for (const unbind of bindings) unbind();
			view.destroy();
			host.remove();
		},
	};
}
