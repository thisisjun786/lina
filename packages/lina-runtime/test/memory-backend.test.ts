import { expect, test } from "bun:test";
import { parseMemoryBackend } from "../src/context/backend.ts";

test("startup chooses native memory and rejects accidental backend typos", () => {
	expect(parseMemoryBackend(undefined)).toBe("native");
	expect(parseMemoryBackend("honcho")).toBe("honcho");
	expect(parseMemoryBackend("disabled")).toBe("disabled");
	expect(() => parseMemoryBackend("Native")).toThrow();
});
