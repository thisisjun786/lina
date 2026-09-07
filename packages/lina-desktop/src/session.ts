import { randomBytes, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { DesktopConfig } from "./config.ts";

export function createBrokerSession() {
	const secret = randomBytes(32).toString("hex");
	return {
		cookie(origin: string) {
			return {
				url: origin,
				name: "lina_desktop",
				value: secret,
				path: "/",
				httpOnly: true,
				sameSite: "strict" as const,
				secure: false,
			};
		},
		authorizes(header: string | undefined): boolean {
			const values = (header ?? "")
				.split(";")
				.map((part) => part.trim())
				.filter((part) => part.startsWith("lina_desktop="));
			const value = values[0]?.slice("lina_desktop=".length);
			return (
				values.length === 1 &&
				value !== undefined &&
				/^[a-f0-9]{64}$/.test(value) &&
				timingSafeEqual(Buffer.from(value), Buffer.from(secret))
			);
		},
	};
}
export type BrokerSession = ReturnType<typeof createBrokerSession>;

/** A stable origin is also the renderer's draft/localStorage identity. */
export async function bindProfile(config: DesktopConfig): Promise<void> {
	await mkdir(config.userData, { recursive: true, mode: 0o700 });
	await mkdir(config.sessionData, { recursive: true, mode: 0o700 });
	const file = join(config.userData, "connection.json");
	const binding = {
		serverOrigin: config.serverOrigin,
		brokerPort: config.brokerPort,
	};
	try {
		await writeFile(file, `${JSON.stringify(binding)}\n`, {
			flag: "wx",
			mode: 0o600,
		});
	} catch (error) {
		if (
			!(error instanceof Error) ||
			!("code" in error) ||
			error.code !== "EEXIST"
		)
			throw error;
		const saved: unknown = JSON.parse(await readFile(file, "utf8"));
		if (
			!saved ||
			typeof saved !== "object" ||
			!("serverOrigin" in saved) ||
			!("brokerPort" in saved) ||
			saved.serverOrigin !== binding.serverOrigin ||
			saved.brokerPort !== binding.brokerPort
		)
			throw Error(
				"Desktop profile belongs to a different server or broker port. Choose a separate LINA_DESKTOP_USER_DATA directory.",
			);
	}
}
