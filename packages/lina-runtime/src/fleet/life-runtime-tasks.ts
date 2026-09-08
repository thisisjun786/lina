import { TaskManager } from "../../../lina-codex/src/tasks.ts";
import type { FleetLifeForeground } from "./life-runtime-state.ts";

/** TaskManager's change notice may follow turn/start; admission must preempt LIFE first. */
export class FleetLifeTasks extends TaskManager {
	constructor(
		options: ConstructorParameters<typeof TaskManager>[0],
		private readonly foreground: () => FleetLifeForeground,
	) {
		super(options);
	}
	private async activity<T>(run: () => Promise<T>): Promise<T> {
		const finish = this.foreground().begin();
		try {
			return await run();
		} finally {
			finish();
		}
	}
	override create(...args: Parameters<TaskManager["create"]>) {
		return this.activity(() => super.create(...args));
	}
	override message(...args: Parameters<TaskManager["message"]>) {
		return this.activity(() => super.message(...args));
	}
	override restore(...args: Parameters<TaskManager["restore"]>) {
		return this.activity(() => super.restore(...args));
	}
}
