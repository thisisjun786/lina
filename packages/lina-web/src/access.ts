const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** Host is an authority, never an arbitrary URL or a forwarded-header assertion. */
function authority(host: string | null, protocol = "http:"): URL | undefined {
	if (host === null || host.length === 0 || /[\s\\/?#@]/u.test(host)) return;
	try {
		return new URL(`${protocol}//${host}`);
	} catch {
		return;
	}
}

function configuredOrigin(raw: string | undefined): URL | undefined {
	if (raw === undefined) return;
	let url: URL;
	try {
		url = new URL(raw);
	} catch {
		throw new Error("Invalid LINA_WEB_ORIGIN");
	}
	if (
		!["http:", "https:"].includes(url.protocol) ||
		url.username ||
		url.password ||
		url.pathname !== "/" ||
		url.search ||
		url.hash ||
		url.hostname.includes("*")
	) {
		throw new Error(
			"LINA_WEB_ORIGIN must be an exact HTTP(S) origin without credentials, path, query or fragment.",
		);
	}
	return url;
}

export function createAccessPolicy(rawPublicOrigin?: string) {
	const publicUrl = configuredOrigin(rawPublicOrigin);
	const isLoopback = (host: string | null): boolean => {
		const parsed = authority(host);
		return parsed !== undefined && LOOPBACK_HOSTS.has(parsed.hostname);
	};
	const isPublicHost = (host: string | null): boolean =>
		publicUrl !== undefined &&
		authority(host, publicUrl.protocol)?.origin === publicUrl.origin;

	return {
		allowsHost(host: string | null): boolean {
			return isLoopback(host) || isPublicHost(host);
		},
		allowsSocket(host: string | null, origin: string | null): boolean {
			const local = isLoopback(host);
			if (!local && !isPublicHost(host)) return false;
			if (publicUrl !== undefined && origin === publicUrl.origin) return true;
			return local && origin === authority(host)?.origin;
		},
	};
}
