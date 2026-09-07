/** Both browser and desktop broker expose the same origin-scoped resource contract. */
export function socketUrl(origin: string, path: string): string {
	const url = new URL(path, origin);
	if (
		url.origin !== new URL(origin).origin ||
		!["http:", "https:"].includes(url.protocol)
	)
		throw new Error("Invalid Lina socket origin");
	url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
	return url.href;
}

export type DesktopPlatform = { readonly platform: "desktop" };
