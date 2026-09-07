export async function openFrameClient(url: string, origin?: string) {
	const socket = new WebSocket(
		url,
		origin ? { headers: { Origin: origin } } : undefined,
	);
	const queue: unknown[] = [],
		waiting: { resolve(value: unknown): void; reject(error: Error): void }[] =
			[];
	let closed = false;
	socket.addEventListener("message", (event) => {
		const value: unknown = JSON.parse(String(event.data));
		const waiter = waiting.shift();
		if (waiter) waiter.resolve(value);
		else queue.push(value);
	});
	socket.addEventListener("close", () => {
		closed = true;
		for (const waiter of waiting.splice(0))
			waiter.reject(new Error("Socket closed"));
	});
	await new Promise<void>((resolve, reject) => {
		socket.addEventListener("open", () => resolve(), { once: true });
		socket.addEventListener("error", () => reject(new Error("Socket failed")), {
			once: true,
		});
	});
	const next = () =>
		queue.length
			? Promise.resolve(queue.shift())
			: closed
				? Promise.reject(new Error("Socket closed"))
				: new Promise<unknown>((resolve, reject) =>
						waiting.push({ resolve, reject }),
					);
	return {
		socket,
		next,
		send: (frame: unknown) => socket.send(JSON.stringify(frame)),
		close: () => socket.close(),
		async until(type: string) {
			for (let i = 0; i < 200; i++) {
				const frame = await next();
				if (
					typeof frame === "object" &&
					frame !== null &&
					"type" in frame &&
					frame.type === type
				)
					return frame;
			}
			throw new Error("Frame not observed");
		},
	};
}
