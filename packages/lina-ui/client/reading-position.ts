export type ReadingPosition = {
	id: string | null;
	offset: number;
	bottom: boolean;
};

export function captureReadingPosition(): ReadingPosition {
	const scroll = document.getElementById("conversation-scroll");
	if (!scroll) return { id: null, offset: 0, bottom: true };
	const top = scroll.getBoundingClientRect().top;
	const node = Array.from(
		scroll.querySelectorAll<HTMLElement>("[data-message-id]"),
	).find((item) => item.getBoundingClientRect().bottom > top);
	return {
		id: node?.dataset["messageId"] ?? null,
		offset: node ? node.getBoundingClientRect().top - top : 0,
		bottom:
			!node ||
			scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 80,
	};
}

export function restoreReadingPosition(position: ReadingPosition): boolean {
	const scroll = document.getElementById("conversation-scroll");
	if (!scroll || !scroll.clientHeight) return false;
	if (position.bottom) {
		scroll.scrollTop = scroll.scrollHeight;
		return true;
	}
	const node = Array.from(
		scroll.querySelectorAll<HTMLElement>("[data-message-id]"),
	).find((item) => item.dataset["messageId"] === position.id);
	if (!node) return false;
	scroll.scrollTop +=
		node.getBoundingClientRect().top -
		scroll.getBoundingClientRect().top -
		position.offset;
	return true;
}

export function saveReadingPosition(
	agentId: string,
	sessionId: string,
	position: ReadingPosition,
): void {
	try {
		localStorage.setItem(
			`lina.reading.v1.${agentId}`,
			JSON.stringify({ sessionId, position }),
		);
	} catch {
		/* Keep in-memory restoration. */
	}
}
export function loadReadingPosition(
	agentId: string,
	sessionId: string,
): ReadingPosition | undefined {
	try {
		const value: unknown = JSON.parse(
			localStorage.getItem(`lina.reading.v1.${agentId}`) ?? "null",
		);
		if (
			!value ||
			typeof value !== "object" ||
			!("sessionId" in value) ||
			value.sessionId !== sessionId ||
			!("position" in value)
		)
			return;
		const position = value.position;
		if (
			position &&
			typeof position === "object" &&
			"id" in position &&
			(typeof position.id === "string" || position.id === null) &&
			"offset" in position &&
			typeof position.offset === "number" &&
			Number.isFinite(position.offset) &&
			"bottom" in position &&
			typeof position.bottom === "boolean"
		)
			return {
				id: position.id,
				offset: position.offset,
				bottom: position.bottom,
			};
	} catch {
		/* Corrupted optional device state does not block conversation. */
	}
	return;
}
