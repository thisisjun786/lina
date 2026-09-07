import { createHash } from "node:crypto";
import { join } from "node:path";
import { ApprovalGate, ControlStore } from "../src/control/index.ts";
import { Fixture } from "./fixture.ts";

export class ControlFixture extends Fixture {
	readonly controlFile = join(this.dir, "control.sqlite");
	time = 1_000_000;
	readonly tasks = new Map<object, { at: number; run(): void }>();
	readonly now = () => this.time;
	readonly schedule = (run: () => void, delay: number) => {
		const key = {};
		this.tasks.set(key, { at: this.time + delay, run });
		return () => {
			this.tasks.delete(key);
		};
	};
	readonly controls = this.keep(
		new ControlStore(this.controlFile, this.binding, { now: this.now }),
	);
	readonly gate = this.keep(
		new ApprovalGate(this.controls, { now: this.now, schedule: this.schedule }),
	);

	advance(ms: number): void {
		this.time += ms;
		for (const [key, task] of [...this.tasks]) {
			if (task.at <= this.time) {
				this.tasks.delete(key);
				task.run();
			}
		}
	}

	tool(nativeCallId = "native-reused", requestId = "request-0") {
		return this.controls.createTool({
			nativeCallId,
			requestId,
			name: "custom-operation",
			inputPreview: "preview",
		});
	}

	pending(toolRunId = this.tool().id, inputJson = '{"a":1}') {
		return this.controls.createApproval({
			toolRunId,
			inputJson,
			inputDigest: digest(inputJson),
			expiresAt: this.time + 300_000,
		});
	}
}

export function digest(json: string): string {
	return createHash("sha256").update(json).digest("hex");
}
