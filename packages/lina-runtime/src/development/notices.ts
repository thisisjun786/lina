export const DEVELOPMENT_NOTICE_TYPE = "lina.development";
export type DevelopmentNoticeMarker = {
	jobId: string;
	terminalRevision: number;
};
type Fields = Record<string, unknown>;
function record(raw: unknown): Fields | undefined {
	return raw && typeof raw === "object" && !Array.isArray(raw)
		? (raw as Fields)
		: undefined;
}
function marker(raw: unknown): DevelopmentNoticeMarker | undefined {
	const value = record(raw);
	if (
		!value ||
		Object.keys(value).length !== 2 ||
		typeof value["jobId"] !== "string" ||
		!/^[A-Za-z0-9_-]{1,128}$/.test(value["jobId"]) ||
		!Number.isSafeInteger(value["terminalRevision"]) ||
		(value["terminalRevision"] as number) < 1
	)
		return;
	return {
		jobId: value["jobId"],
		terminalRevision: value["terminalRevision"] as number,
	};
}
export function developmentNotice(
	raw: unknown,
):
	| { entryId: string; marker: DevelopmentNoticeMarker; text: string }
	| undefined {
	const entry = record(raw),
		value = marker(entry?.["details"]);
	if (
		!entry ||
		!value ||
		entry["type"] !== "custom_message" ||
		entry["customType"] !== DEVELOPMENT_NOTICE_TYPE ||
		entry["display"] !== true ||
		typeof entry["id"] !== "string" ||
		typeof entry["content"] !== "string" ||
		entry["content"].length > 2048
	)
		return;
	return { entryId: entry["id"], marker: value, text: entry["content"] };
}
type NoticeMessage = {
	customType: string;
	content: string;
	display: boolean;
	details: DevelopmentNoticeMarker;
};
type NoticePort = {
	history(): readonly unknown[];
	idle(): boolean;
	send(message: NoticeMessage): Promise<void>;
};

/** A marker is application identity; the returned ID is observed native persistence. */
export function createNoticeWriter(port: NoticePort) {
	let tail = Promise.resolve();
	return (
		input: DevelopmentNoticeMarker,
		text: string,
	): Promise<string | null> => {
		const run = tail.then(async () => {
			const wanted = marker(input);
			if (
				!wanted ||
				typeof text !== "string" ||
				!text.trim() ||
				text.length > 2048
			)
				throw new Error("Invalid development notice");
			const find = () =>
				port
					.history()
					.map(developmentNotice)
					.find(
						(entry) =>
							entry?.marker.jobId === wanted.jobId &&
							entry.marker.terminalRevision === wanted.terminalRevision,
					);
			const existing = find();
			if (existing) return existing.entryId;
			if (!port.idle()) return null;
			await port.send({
				customType: DEVELOPMENT_NOTICE_TYPE,
				content: text,
				display: true,
				details: wanted,
			});
			const committed = find();
			if (!committed) throw new Error("Development notice did not commit");
			return committed.entryId;
		});
		tail = run.then(
			() => undefined,
			() => undefined,
		);
		return run;
	};
}
