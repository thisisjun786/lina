import { Button as ButtonPrimitive } from "@base-ui/react/button";

/** shadcn base-nova Button, with Lina's shared CSS tokens instead of Tailwind. */
export function Button({
	className = "",
	variant = "ghost",
	size = "default",
	...props
}: ButtonPrimitive.Props & {
	variant?: "default" | "secondary" | "ghost" | "outline" | "destructive";
	size?: "default" | "icon";
}) {
	return (
		<ButtonPrimitive
			data-slot="button"
			data-variant={variant}
			data-size={size}
			className={`ui-button ${className}`}
			{...props}
		/>
	);
}
