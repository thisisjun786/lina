import { expect, test } from "bun:test";
import {
	approvalDescriptor,
	COMMAND_DETAIL_MAX_CHARS,
	toolLabel,
	toolSummary,
} from "../client/tool-label.ts";

test("tool labels map known tools and bound unknown names", () => {
	for (const name of [
		"lina_develop_start",
		"lina_develop_status",
		"lina_develop_output",
		"lina_develop_cancel",
	]) {
		expect(toolLabel(name)).toBe(name);
	}
	expect(toolLabel("read")).toBe("파일 읽기");
	expect(toolLabel("bash")).toBe("명령 실행");
	expect(toolLabel("lina_status")).toBe("상태 확인");
	expect(toolLabel("custom_thing")).toBe("custom_thing");
	expect(toolLabel("<img onerror=x>")).toBe("<img onerror=x>");
	expect(toolLabel("y".repeat(200))).toBe("y".repeat(64));
	expect(toolLabel(undefined)).toBe("도구 결과");
	expect(toolLabel("constructor")).toBe("constructor");
});

test("tool summaries keep normal results quiet and surface only confirmed failure", () => {
	expect(toolSummary({ name: "bash", isError: true })).toEqual({
		label: "명령 실행",
		badge: "실패",
		tone: "failed",
	});
	expect(toolSummary({ name: "read", isError: false })).toEqual({
		label: "파일 읽기",
		badge: "",
		tone: "",
	});
	expect(toolSummary({ name: "read" })).toEqual({
		label: "파일 읽기",
		badge: "",
		tone: "",
	});
	expect(toolSummary(undefined)).toEqual({
		label: "도구 결과",
		badge: "",
		tone: "",
	});
});

test("approval descriptors name the tool and a bounded target", () => {
	expect(
		approvalDescriptor("read", JSON.stringify({ path: "/home/example/a.md" })),
	).toBe("/home/example/a.md");
	expect(
		approvalDescriptor("bash", JSON.stringify({ command: "bun --version" })),
	).toBe("bun --version");
	const long = "a".repeat(COMMAND_DETAIL_MAX_CHARS);
	expect(approvalDescriptor("bash", JSON.stringify({ command: long }))).toBe(
		long,
	);
	expect(
		approvalDescriptor("bash", JSON.stringify({ command: `${long}b` })),
	).toBe(`명령 ${COMMAND_DETAIL_MAX_CHARS + 1}자 · 1줄`);
	expect(
		approvalDescriptor(
			"bash",
			JSON.stringify({ command: "printf a; rm x\ncat y\n" }),
		),
	).toBe("명령 21자 · 3줄");
	const deep = `/${"d".repeat(150)}/file.ts`;
	const shown = approvalDescriptor("write", JSON.stringify({ path: deep }));
	expect(shown.length).toBeLessThanOrEqual(COMMAND_DETAIL_MAX_CHARS);
	expect(shown.startsWith("…")).toBe(true);
	expect(shown.endsWith("/file.ts")).toBe(true);
});

test("approval descriptors stay neutral for unknown or malformed input", () => {
	expect(approvalDescriptor("lina_status", "{}")).toBe("인수 없음");
	expect(
		approvalDescriptor("custom", JSON.stringify({ alpha: 1, beta: [2] })),
	).toBe("인수 2개");
	expect(approvalDescriptor("bash", "{not json")).toBe("입력 확인 불가");
	expect(approvalDescriptor("bash", JSON.stringify({ command: 7 }))).toBe(
		"인수 1개",
	);
	expect(approvalDescriptor("read", JSON.stringify(["path"]))).toBe(
		"입력 확인 불가",
	);
	expect(
		approvalDescriptor("read", JSON.stringify({ path: "a\u0000b\tc" })),
	).toBe("a b c");
});
