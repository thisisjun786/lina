import {
	acquireSessionLease,
	acquireTranscriptLease,
} from "../src/session-binding.ts";

const [root, workspace, transcript] = process.argv.slice(2);
if (!root || !workspace || !transcript)
	throw new Error("missing child arguments");
const sessionLease = acquireSessionLease(root, "lina", workspace);
const transcriptLease = acquireTranscriptLease(transcript, "lina", workspace);
if (process.argv[5] === "after-binding") {
	sessionLease.bind({
		version: 1,
		botId: "lina",
		sessionId: "session-1",
		workspace,
		sessionFile: transcript,
	});
}
process.stdout.write("ready\n");
await new Promise<void>((resolve) => {
	process.stdin.once("end", resolve);
	process.stdin.resume();
});
transcriptLease.close();
sessionLease.close();
