import { expect, test } from "bun:test";
import { createTaskTransport } from "../src/fleet/task-transport.ts";

test("task transport is lazy, initializes once and answers the same server request", async () => {
	let starts = 0;
	const calls: string[] = [];
	let handler:
		| ((method: string, params: unknown) => Promise<unknown>)
		| undefined;
	const transport = createTaskTransport(async () => {
		starts++;
		return {
			closed: false,
			request: async <T>(method: string): Promise<T> => {
				calls.push(method);
				return {} as T;
			},
			notify: (method: string) => {
				calls.push(method);
			},
			subscribe: () => () => {},
			onRequest: (next: typeof handler) => {
				handler = next;
				return () => {};
			},
			close: async () => {
				calls.push("close");
			},
		};
	});
	expect(starts).toBe(0);
	await Promise.all([
		transport.request("thread/read"),
		transport.request("model/list"),
	]);
	expect(starts).toBe(1);
	expect(calls.slice(0, 2)).toEqual(["initialize", "initialized"]);
	let approval = "";
	transport.subscribeRequests((request) => {
		approval = String(request.id);
	});
	const answer = handler?.("item/commandExecution/requestApproval", {
		threadId: "same",
	});
	expect(approval).not.toBe("");
	await transport.respond(approval, { decision: "decline" });
	expect(await answer).toEqual({ decision: "decline" });
	await expect(transport.respond(approval, {})).rejects.toThrow("Unknown");
	await transport.close();
	expect(calls.at(-1)).toBe("close");
});

test("failed handshake closes only its proxy and permits a later connection attempt", async () => {
	let closed = 0;
	const transport = createTaskTransport(async () => ({
		closed: false,
		request: async () => {
			throw Error("offline");
		},
		notify: () => {},
		subscribe: () => () => {},
		onRequest: () => () => {},
		close: async () => {
			closed++;
		},
	}));
	await expect(transport.request("thread/list")).rejects.toThrow("offline");
	await expect(transport.request("thread/list")).rejects.toThrow("offline");
	expect(closed).toBe(2);
	await transport.close();
});

test("unknown native request kinds fail promptly without creating an unanswered approval", async () => {
	let handler:
		| ((method: string, params: unknown) => Promise<unknown>)
		| undefined;
	const transport = createTaskTransport(async () => ({
		closed: false,
		request: async <T>() => ({}) as T,
		notify() {},
		subscribe: () => () => {},
		onRequest(next) {
			handler = next;
			return () => {};
		},
		close: async () => {},
	}));
	transport.subscribeRequests(() => {
		throw Error("must not dispatch");
	});
	await transport.request("thread/read");
	await expect(
		handler?.("item/permissions/requestApproval", { threadId: "managed" }),
	).rejects.toThrow("Unsupported");
	await transport.close();
});
