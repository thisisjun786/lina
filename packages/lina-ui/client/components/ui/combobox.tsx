import { Combobox as Primitive } from "@base-ui/react/combobox";

/** shadcn-style composition; Base UI owns widget interactions and positioning. */
export const Combobox = Primitive.Root;
export const ComboboxInput = Primitive.Input;
export const ComboboxList = Primitive.List;
export const ComboboxItem = Primitive.Item;
export const ComboboxEmpty = Primitive.Empty;

export function ComboboxContent({
	container,
	collisionBoundary,
	...props
}: Primitive.Popup.Props &
	Pick<Primitive.Portal.Props, "container"> &
	Pick<Primitive.Positioner.Props, "collisionBoundary">) {
	return (
		<Primitive.Portal container={container}>
			<Primitive.Positioner
				className="model-combobox-positioner"
				align="start"
				sideOffset={5}
				collisionPadding={8}
				collisionBoundary={collisionBoundary}
			>
				<Primitive.Popup
					className="model-combobox-popup"
					data-slot="combobox-content"
					{...props}
				/>
			</Primitive.Positioner>
		</Primitive.Portal>
	);
}
