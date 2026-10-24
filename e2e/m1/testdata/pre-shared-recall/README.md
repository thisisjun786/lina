# Episode before the shared recall entry

`TestM1PreSharedRecallReplayInstalledCore` replays an export produced by the
unmodified binary at `9b6e6d2b9c3a74141b4d9b5297a6448d17d9d201`, the first
parent of PR #1670's merge commit
`9033e59018c8f0d2b1bd0831b3efded33f223307`.

The recording uses the existing installed-Core harness and a loopback Responses
server. It remembers a synthetic preference for violet ink and records one
person turn about a violet notebook. Positive and negative memory text queries
run through the old installed API; the old ledger search finds the original
input by identity. The old CLI exports and successfully replays the turn.

The producer did not expose `recall_person` or `expand` in its native catalog.
The [owner's scope decision](https://github.com/lina-system/lina/issues/1744#issuecomment-6385396120)
therefore limits historical compatibility to ledger search and memory text
matching. No tool registration, production-source patch or invented tool receipt
is used to create this fixture.

The current test verifies the successful CLI manifest and independently hashes
the model-bound request against the original recorded digest. It also checks
positive and negative memory/ledger searches over the restored old sources.
This covers the existing [Replay command](../../../../docs/design/runtime.md#replay-command)
and [Episode export](../../../../docs/design/conversation-and-memory.md#episode-export)
contracts; no product behavior changes.

- `episodes.jsonl` is the old CLI's unmodified export (60,066 bytes).
  SHA-256: `356ac160d1ea6fa195f63969a0ef7c5fb051efad71f139f058d3ba18d61d8507`.
  Recorded request digest:
  `e147ba6224ede52b79ad0ad5a47058a76b83cfaf0534398a945c27e5e5aa135a`.
- `sources.tar.gz` is the companion synthetic source seed (282,433 bytes):
  canon, immutable materials/persona revisions and the generated install identity.
  Normal replay rehydrates local sources and checks their current visibility;
  the exported bytes alone cannot authorize a replay. Machine observations,
  sign-in host identity and queued background work are removed from a disposable
  database copy, then `VACUUM` removes their bytes from free pages. The connection closes before
  packaging so WAL changes are checkpointed into the archived database. The source
  events and request evidence are unchanged. No credentials, installed binaries,
  sockets, user data or logs are included.
- `record_test.go.txt` is the historical recorder. Its text extension keeps it
  out of routine tests. `package_fixture.py` creates the source archive with
  relative paths and neutral ownership/timestamps.

To reproduce, create a new temporary directory **inside this worktree**, extract
`git archive 9b6e6d2b9c3a74141b4d9b5297a6448d17d9d201` into its `old/`
subdirectory, and copy `record_test.go.txt` to
`old/e2e/m1/old_recall_record_test.go`. From that extracted source, run:

```sh
export GOFLAGS=-p=2
export GOMAXPROCS=2
dv heavy -- bash -c 'go build -ldflags=-w -o ../lina-old ./cmd/lina &&
  go build -ldflags=-w -o ../lina-node-old ./cmd/lina-node &&
  go test ./e2e/m1 -run "^TestRecordPreSharedRecall$" -count=1 -v'
```

The recorder writes `episodes.jsonl`, `canon/`, `materials/` and `versions/`
beside `old/`. From the current worktree, run
`python3 e2e/m1/testdata/pre-shared-recall/package_fixture.py <recording-directory> <fixture-directory>`.
Review the generated files before replacing the fixture, then remove the
temporary recording directory. New recordings have new synthetic ids and clocks;
do not regenerate this fixture with the current producer or recompute its digest.

Run the current regression with:

```sh
export GOFLAGS=-p=2
export GOMAXPROCS=2
dv heavy -- go test ./e2e/m1 -run '^TestM1PreSharedRecallReplayInstalledCore$' -count=1 -v
go test ./internal/core/replay/
```
