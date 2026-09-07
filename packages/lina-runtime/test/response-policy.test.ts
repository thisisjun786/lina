import { expect, test } from "bun:test";
import { ResponsePolicy, splitPolicy } from "../src/policy/response.ts";

test("conversation policy keeps common evidence/identity rules and selects workflow instructions only when requested", () => {
	const base =
		"# Global\nCore\n## 1. Talk\nLanguage\n## 7. Work\nWORK\n## 8. Delegate\nCODE\n## 9. Tools\nREAD\n## 10. Permissions\nAUTH";
	const split = splitPolicy(base);
	expect(split.common).toContain("AUTH");
	expect(split.common).not.toContain("CODE");
	const policy = new ResponsePolicy(base);
	expect(policy.current().mode).toBe("conversation");
	expect(policy.select("execution").instructions).toContain("CODE");
	expect(policy.select("research").instructions).toContain("READ");
	expect(policy.select("research").instructions).not.toContain("CODE");
	policy.reset();
	expect(policy.current().mode).toBe("conversation");
	expect(policy.select("clarify").instructions).not.toContain("CODE");
	expect(() => policy.select("privileged" as never)).toThrow();
	expect(policy.current().mode).toBe("clarify");
});

test("workflow extraction is keyed by meaning and never removes unrelated numbered global rules", () => {
	const base =
		"## 7. Safety\nALWAYS_SAFE\n## 8. Dialogue\nKEEP_DIALOGUE\n## 9. Voice\nKEEP_VOICE";
	const result = splitPolicy(base);
	expect(result.common).toContain("ALWAYS_SAFE");
	expect(result.common).toContain("KEEP_DIALOGUE");
	expect(result.common).toContain("KEEP_VOICE");
});
