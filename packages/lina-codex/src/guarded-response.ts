// Trusted delivery capabilities follow object identity, never serialized metadata.
const checks = new WeakMap<object, () => void>();

export function composeDeliveryChecks(
	...callbacks: ReadonlyArray<(() => void) | undefined>
): (() => void) | undefined {
	const retained = callbacks.filter((check) => check !== undefined);
	return retained.length
		? () => {
				for (const check of retained) check();
			}
		: undefined;
}

export function guardResponse<T extends object>(
	response: T,
	beforeDeliver?: () => void,
): T {
	if (beforeDeliver) checks.set(response, beforeDeliver);
	return response;
}

export function responseDeliveryCheck(
	value: unknown,
): (() => void) | undefined {
	return typeof value === "object" && value !== null
		? checks.get(value)
		: undefined;
}
