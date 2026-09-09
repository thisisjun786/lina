import { FakeCodexRpc } from "../../lina-codex/test/task-fake-rpc.test.ts";
import { fleetLifeFixture } from "./life-runtime-fleet-fixture.ts";

/** Actual task manager and Fleet owners; only the external Codex transport is synthetic. */
export async function lifeAcceptanceFixture(
	overrides: Parameters<typeof fleetLifeFixture>[0] = {},
) {
	const rpc = new FakeCodexRpc();
	const f = await fleetLifeFixture({
		...overrides,
		createTaskRpc: async () => ({
			request: <T>(method: string, params?: unknown, signal?: AbortSignal) =>
				method === "initialize"
					? Promise.resolve({} as T)
					: rpc.request<T>(method, params, signal),
			notify() {},
			subscribe: (listener) =>
				rpc.subscribe(({ method, params }) => listener(method, params)),
			onRequest: () => () => {},
			close: async () => {},
			closed: false,
			pid: undefined,
		}),
	});
	return { f, rpc };
}
