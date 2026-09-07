import { assertNever, type OutboundFrame } from "./frames.ts";

export type TurnCollectorState =
	| "unsynchronized"
	| "idle"
	| "collecting"
	| "discarding";

type TurnEmitter = (text: string) => void;

export type TurnCollector = {
	readonly accept: (frame: OutboundFrame) => void;
	readonly close: () => void;
	readonly state: () => TurnCollectorState;
};

export function createTurnCollector(emit: TurnEmitter): TurnCollector {
	let current: TurnCollectorState = "unsynchronized";
	const partial: string[] = [];

	function accept(frame: OutboundFrame): undefined {
		switch (current) {
			case "unsynchronized":
				if (frame.type === "agent-status" && frame.state === "idle")
					current = "idle";
				return;
			case "idle":
				if (frame.type === "agent-status" && frame.state === "running") {
					partial.length = 0;
					current = "collecting";
				}
				return;
			case "collecting":
				switch (frame.type) {
					case "agent-text":
						partial.push(frame.text);
						return;
					case "agent-status":
						if (frame.state === "idle") {
							const completed = partial.join("\n\n").trim();
							partial.length = 0;
							current = "idle";
							emit(completed);
						}
						return;
					case "ack":
					case "error":
					case "agent-thinking":
						return;
					default:
						return assertNever(frame);
				}
			case "discarding":
				if (frame.type === "agent-status" && frame.state === "idle")
					current = "idle";
				return;
			default:
				assertNever(current);
		}
	}

	return {
		accept,
		close(): void {
			partial.length = 0;
			current = "discarding";
		},
		state: () => current,
	};
}
