import { PassThrough } from "node:stream";
import { contextRpc } from "./context-policy-rpc.ts";

/** Real serialized RPC with controllable native replies, after real qualification. */
export function authorRpcFixture(
	root: string,
	workspace: string,
	config: string,
	model: string,
) {
	const base = contextRpc(root);
	const input = new PassThrough(),
		output = new PassThrough();
	const methods = new Map<string | number, string>();
	let toNative = "",
		fromNative = "";
	let state: "normal" | "skills" | "mcp" | "profile" | "provider" = "normal";
	const emit = (frame: unknown) => output.write(JSON.stringify(frame) + "\n");
	input.on("data", (bytes: Buffer) => {
		toNative += bytes.toString();
		let end = toNative.indexOf("\n");
		while (end >= 0) {
			const line = toNative.slice(0, end),
				frame = JSON.parse(line);
			toNative = toNative.slice(end + 1);
			end = toNative.indexOf("\n");
			if (frame.id !== undefined && frame.method)
				methods.set(frame.id, frame.method);
			if (frame.method === "config/read") {
				// The fixture receives the factory's generated provider table.
				const effective = Bun.TOML.parse(config) as {
					model_providers: { opencodex: { base_url: string } };
				};
				if (state === "provider")
					effective.model_providers.opencodex.base_url =
						"http://127.0.0.1:1/foreign";
				emit({ id: frame.id, result: { config: effective } });
				continue;
			}
			if (frame.method === "configRequirements/read") {
				emit({ id: frame.id, result: { requirements: null } });
				continue;
			}
			if (frame.method === "mcpServerStatus/list") {
				emit({
					id: frame.id,
					result: {
						data: state === "mcp" ? [{ name: "foreign" }] : [],
						nextCursor: null,
					},
				});
				continue;
			}
			base.options.stdio.input.write(line + "\n");
		}
	});
	base.options.stdio.output.on("data", (bytes: Buffer) => {
		fromNative += bytes.toString();
		let end = fromNative.indexOf("\n");
		while (end >= 0) {
			const frame = JSON.parse(fromNative.slice(0, end));
			fromNative = fromNative.slice(end + 1);
			end = fromNative.indexOf("\n");
			const method = methods.get(frame.id);
			if (frame.result && method === "model/list")
				frame.result = { data: [{ id: model, model }] };
			if (frame.result && method === "skills/list" && state === "skills")
				frame.result = {
					data: [{ skills: [{ name: "foreign" }], errors: [] }],
				};
			if (
				frame.result &&
				(method === "thread/start" || method === "thread/resume")
			) {
				frame.result = {
					...frame.result,
					activePermissionProfile: {
						id: state === "profile" ? "full-access" : "author",
						extends: null,
					},
					approvalPolicy: "never",
					cwd: workspace,
					model,
					modelProvider: "opencodex",
					runtimeWorkspaceRoots: [],
					instructionSources: [],
				};
				frame.result.thread.modelProvider = "opencodex";
			}
			emit(frame);
		}
	});
	return {
		...base,
		options: { stdio: { input, output }, ownsProcess: false, timeoutMs: 3000 },
		state(value: typeof state) {
			state = value;
		},
		async request(
			method: string,
			threadId: string,
			params: Record<string, unknown> = {},
		) {
			const id = `author-native-${crypto.randomUUID()}`;
			emit({ id, method, params: { threadId, ...params } });
			return base.next(`response:${id}`);
		},
		close() {
			base.close();
			input.destroy();
			output.destroy();
		},
	};
}
