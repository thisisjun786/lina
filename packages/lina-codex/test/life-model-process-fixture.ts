import { createCodexLifeModel } from "../src/life-model.ts";
import { LifeModelJournal } from "../src/life-model-journal.ts";
import { lifeMetadata } from "./life-model-fixture.ts";

const input = await Bun.stdin.json();
if (input.mode === "crash_after_usage") {
	const original = LifeModelJournal.prototype.write;
	LifeModelJournal.prototype.write = function (name, value) {
		original.call(this, name, value);
		if (name === "usage") process.kill(process.pid, "SIGKILL");
	};
}
const port = createCodexLifeModel({
	stateRoot: input.root,
	selection() {
		if (input.mode === "reconcile")
			throw Error("Reconciliation consulted selection");
		return {
			connection: {
				origin: input.origin,
				baseUrl: `${input.origin}/v1`,
				catalogJson: JSON.stringify({ models: [lifeMetadata] }),
				catalogSource: "hub",
				requiresAdmissionToken: true,
				tokenEnv: "OPENCODEX_API_AUTH_TOKEN",
				providerTable: "unused",
			},
			selected: {
				id: "life",
				provider: "opencodex",
				model: lifeMetadata.slug,
				reasoning: "off",
			},
			settingsRevision: 7,
		};
	},
	providerEnv: () => ({
		OPENCODEX_API_AUTH_TOKEN: "synthetic-parent-credential",
	}),
});
try {
	const value =
		input.mode === "prepare"
			? await port.prepare(input.request, new AbortController().signal)
			: input.mode === "reconcile"
				? await port.reconcile(input.prepared)
				: await port.complete(input.prepared, new AbortController().signal);
	await port.close();
	console.log(JSON.stringify({ ok: true, value }));
} catch {
	await port.close();
	console.log(JSON.stringify({ ok: false }));
}
