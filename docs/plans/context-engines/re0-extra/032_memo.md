# Lessons for the next engine change

Keep the existing engines and narrow fixes. No replacement framework or extra feature was needed.

- Selection order is part of durable identity when traversal is capped. Preserve an independent old-algorithm oracle and compare complete separately at exactly64 versus65; identical refs/digest do not prove equal coverage.
- A stored result and its current applicability are different facts. Verify the original output receipt before projecting current completeness. Never promote an originally partial output merely because current data became smaller.
- Safe reconfirmation preserves content hash, generation and support, not just display text. Classification and writes must share the same identity predicate. Test both output orders, corroborating proof changes and late source revocation.
- Count the work actually instrumented. Zero repeated traversal reads does not mean zero snapshot construction or SQL, and a green timeout is not a latency budget. Preserve query counts and wall time separately.
- Durable pending jobs need an explicit recovery path after a new OS process starts. Test both unknown crash outcomes and known cancellation, combined with revocation and stale-token rejection. A same-process reopen is not that evidence.
- An executor dispatch is not implementation evidence. Reconcile its actual changes and reclaim work if it returns none; independent review must still happen. Missing inherited-model support is a routing limitation, not permission to silently pick another model.

Negative corpus and actual surfaces are linked from010/020/030 and retained under the task evidence directory. Final CI failures, if any, remain evidence even when a later run succeeds. Do not extend timeouts, add retries or weaken assertions to erase them.
