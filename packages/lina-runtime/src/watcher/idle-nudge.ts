/** Watcher scaffold: the smallest self-injection loop. Dori's Watcher/Monitor/Escalation extend this shape. */
export type IdleNudgeHost = {
	on(event: "agent_start" | "agent_end", handler: () => void): void;
	sendUserMessage(
		content: string,
		options?: { readonly deliverAs?: "steer" | "followUp" },
	): unknown;
};

export type IdleNudgeOptions = {
	readonly idleTimeoutMs: number;
	readonly nudgeText: string;
};

export interface IdleNudge {
	isArmed(): boolean;
	/** Resolves when the next nudge fires. Tests await this instead of sleeping. */
	nextNudge(): Promise<void>;
	stop(): void;
}

export function installIdleNudge(
	host: IdleNudgeHost,
	options: IdleNudgeOptions,
): IdleNudge {
	let timer: ReturnType<typeof setTimeout> | undefined;
	let waiters: Array<() => void> = [];
	const disarm = (): void => {
		if (timer !== undefined) clearTimeout(timer);
		timer = undefined;
	};
	const fire = (): void => {
		timer = undefined;
		host.sendUserMessage(options.nudgeText);
		const pending = waiters;
		waiters = [];
		for (const resolve of pending) resolve();
	};
	host.on("agent_start", disarm);
	host.on("agent_end", () => {
		disarm();
		timer = setTimeout(fire, options.idleTimeoutMs);
	});
	return {
		isArmed: () => timer !== undefined,
		nextNudge: () => new Promise((resolve) => waiters.push(resolve)),
		stop: disarm,
	};
}
