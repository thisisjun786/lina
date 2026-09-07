import type { MemoryFs } from "./memory-fs.ts";
import type { MemoryBlock } from "./types.ts";

export interface Memorian {
	recall(query: string): Promise<readonly MemoryBlock[]>;
	record(observation: {
		path: string;
		description: string;
		body: string;
	}): Promise<void>;
}

// Dori's memorian additionally runs as a judge subagent.
export function createMemorian(fs: MemoryFs): Memorian {
	return {
		recall: (query) => recall(fs, query),
		record: (observation) => record(fs, observation),
	};
}

async function recall(
	fs: MemoryFs,
	query: string,
): Promise<readonly MemoryBlock[]> {
	const needle = query.toLowerCase();
	const blocks: MemoryBlock[] = [];
	for (const path of await fs.list()) {
		blocks.push(await fs.read(path));
	}
	return [...blocks].sort((left, right) => {
		const delta = matchIndex(left, needle) - matchIndex(right, needle);
		if (delta !== 0) {
			return delta;
		}
		if (left.path < right.path) {
			return -1;
		}
		if (left.path > right.path) {
			return 1;
		}
		return 0;
	});
}

function matchIndex(block: MemoryBlock, needle: string): number {
	const haystack = `${block.description}\n${block.body}`.toLowerCase();
	if (needle.length === 0) {
		return 0;
	}
	const index = haystack.indexOf(needle);
	if (index < 0) {
		return Number.POSITIVE_INFINITY;
	}
	return index;
}

async function record(
	fs: MemoryFs,
	observation: { path: string; description: string; body: string },
): Promise<void> {
	await fs.write(observation.path, {
		description: observation.description,
		body: observation.body,
	});
	await fs.commit(`memory: ${observation.path}`);
}
