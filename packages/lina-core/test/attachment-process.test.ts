import { expect, test } from "bun:test";
import { runDocumentProcess } from "../src/attachments/document.ts";

test("document subprocess has OS-enforced memory and CPU limits", async () => {
	const result = await runDocumentProcess(
		"/usr/bin/python3",
		[
			"-I",
			"-S",
			"-c",
			"import resource,json; print(json.dumps([resource.getrlimit(resource.RLIMIT_AS)[0],resource.getrlimit(resource.RLIMIT_CPU)[0]]))",
		],
		new Uint8Array(),
		new AbortController().signal,
	);
	expect(result.code).toBe(0);
	expect(JSON.parse(new TextDecoder().decode(result.stdout))).toEqual([
		536870912, 20,
	]);
});
