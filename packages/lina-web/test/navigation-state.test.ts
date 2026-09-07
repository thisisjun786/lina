import { expect, test } from "bun:test";
import {
	navigationLayout,
	navigationUrl,
	parseNavigation,
} from "../../lina-client/src/navigation-state.ts";

test("root opens the agent list, direct agent and task links preserve their destination", () => {
	expect(parseNavigation("https://lina.test/")).toEqual({
		screen: "agents",
		agentId: "lina",
	});
	expect(parseNavigation("https://lina.test/?agent=writer")).toEqual({
		screen: "conversation",
		agentId: "writer",
	});
	expect(
		parseNavigation("https://lina.test/?agent=writer&screen=tasks"),
	).toEqual({ screen: "tasks", agentId: "writer" });
	expect(
		parseNavigation("https://lina.test/?agent=../other&screen=bad"),
	).toEqual({ screen: "agents", agentId: "lina" });
});

test("width changes only layout, and extra task column requires explicit choice and room", () => {
	const state = { screen: "conversation" as const, agentId: "writer" };
	expect(navigationUrl(state)).toBe("/?agent=writer&screen=conversation");
	expect(navigationLayout(390, true, 304)).toBe("mobile");
	expect(navigationLayout(1280, true, 304)).toBe("single");
	expect(navigationLayout(1440, false, 304)).toBe("single");
	expect(navigationLayout(1440, true, 420)).toBe("single");
	expect(navigationLayout(1440, true, 304)).toBe("dual");
	expect(state).toEqual({ screen: "conversation", agentId: "writer" });
});

test("task deep links preserve the task key independently of the agent conversation", () => {
	expect(parseNavigation("https://lina.test/?agent=kai&task=task-1")).toEqual({
		screen: "tasks",
		agentId: "kai",
		taskId: "task-1",
	});
	expect(
		navigationUrl({ screen: "tasks", agentId: "kai", taskId: "task-1" }),
	).toBe("/?agent=kai&screen=tasks&task=task-1");
	expect(parseNavigation("https://lina.test/?agent=kai&task=../oops")).toEqual({
		screen: "conversation",
		agentId: "kai",
	});
});
