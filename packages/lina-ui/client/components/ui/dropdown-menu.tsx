import { Menu } from "@base-ui/react/menu";

/** Adapted from shadcn base-nova; behavior stays in Base UI, skin in controls.css. */
export const DropdownMenu = Menu.Root;

export function DropdownMenuContent({
	anchor,
	side = "bottom",
	align = "start",
	...props
}: Menu.Popup.Props &
	Pick<Menu.Positioner.Props, "anchor" | "side" | "align">) {
	return (
		<Menu.Portal>
			<Menu.Positioner
				anchor={anchor}
				side={side}
				align={align}
				sideOffset={6}
				collisionPadding={8}
				className="ui-menu-positioner"
			>
				<Menu.Popup
					data-slot="dropdown-menu-content"
					className="ui-menu"
					{...props}
				/>
			</Menu.Positioner>
		</Menu.Portal>
	);
}

export function DropdownMenuItem(props: Menu.Item.Props) {
	return (
		<Menu.Item
			data-slot="dropdown-menu-item"
			className="ui-menu-item"
			{...props}
		/>
	);
}
