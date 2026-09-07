import { Avatar as AvatarPrimitive } from "@base-ui/react/avatar";

/** Base UI owns image loading and fallback visibility; Lina owns the geometry. */
export function Avatar({
	src,
	fallback,
}: {
	src?: string | undefined;
	fallback: string;
}) {
	return (
		<AvatarPrimitive.Root
			className="avatar"
			data-slot="avatar"
			aria-hidden="true"
		>
			{src && <AvatarPrimitive.Image src={src} alt="" loading="lazy" />}
			<AvatarPrimitive.Fallback>{fallback}</AvatarPrimitive.Fallback>
		</AvatarPrimitive.Root>
	);
}
