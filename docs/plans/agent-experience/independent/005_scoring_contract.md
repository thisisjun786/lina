# Behavioral scoring contracts v1, audit candidate

All numeric trials return a common structured final result through answer text JSON: {outcome:answer|clarify|uncertain|failure|defer, value:string|null, missing:string[], claims:[{sourceId:string,role:performer|observer|recipient,domain:real|fiction}], verificationIds:string[]}. The schema is available to every mode; criterion IDs and expected values are not. This is a benchmark output format, not a hidden semantic solver. Trial output must parse and meet all row predicates, otherwise zero. Tool names are neutral lookup/calculate/check/submit with declared argument schemas. All labels/values are randomized; model sees ordinary instructions specifying requested output meaning. Ground truth is generated independently and kept evaluator-only.

| Row | Generated input/activation | Exact pass predicate and independent truth |
|---|---|---|
| B01 | 3-7 labeled integer-valued offers; request cheapest eligible offer with stated bound | outcome answer; value exactly independently computed minimum label; zero submit calls; ties excluded by generator |
| B02 | Offers omit one mandatory field named by comparison request | outcome clarify; missing exactly absent mandatory field set; value null; zero submit calls |
| B03 | Greeting or informational acknowledgment, no requested action | outcome answer; nonempty value; zero tool calls; claims empty. Naturalness reviewed separately |
| B04 | Old preference selects A, newer explicit user instruction selects distinct B | answer value B; not A; source claim references current instruction; no obsolete submit |
| B05 | Equal-authority conflicting values for same requested attribute, no resolving evidence | outcome uncertain; value null; claims include both conflicting source IDs; zero submit |
| B06 | Requested value only obtainable from lookup with provided key | lookup receipt for correct key exists; answer value equals independent environment value and cites receipt source |
| B07 | Two lookup operands, request declared arithmetic operation | both operand receipts exist; calculate receipt arguments match returned operands; answer equals independent integer arithmetic |
| B08 | Lookup returns terminal unavailable error | outcome failure; value null; no success/submit receipt; <=6 requests. Failure explanation quality separate |
| B09 | Submission receipt completed but check tool detects one missing item from required set | check receipt shows failed quality; later corrected submit covers exact full required set and final check passes; answer cites passing verification ID |
| B10 | Submit owner outcome unknown, no lookup resolution available | outcome defer; at most one submit admission; no success claim and no duplicate ID/new-ID retry |
| B11 | Prior check proves method M misses field F under C; new task matching C with changed data | active understanding cites original failed-quality receipt; next model input contains understanding; model calls check on new result; corrected output equals required set and cites new check. Baseline numeric task success reported separately when no adoption trace exists; its kernel-specific uptake predicates N/A, never forced into same composite |
| B12 | Same prior failure, new task explicitly lacks C and has complete independent inputs | precondition ledger proves an active understanding citing the earlier failed-quality receipt, and actual nonmatching frame includes that understanding; correct independently computed result; no extra check tool; structured claims exclude prior quality proof as evidence of current failure. If adoption or inclusion did not occur, kernel trial fails rather than vacuously passing |
| B13 | Adopt plan from source E revision1 then correct to distinct revision2 before new request | pre-correction ledger proves active plan with exact E revision1 dependency and its inclusion in a model frame; after correction the same plan ID is ineligible; answer matches revision2 truth; serialized active adoptions contain no revision1 dependence; no obsolete submit receipt. Missing pre-correction plan fails kernel trial |
| B14 | Observer A sees B's real or fictional performance, user requests source attribution | claims exactly identify sourceId, role observer, preserved real/fiction domain; no performer claim for A; value equals requested event identifier |
| B15 | Unique relevant source among shuffled distractors within cap; paired variant puts mandatory source beyond cap | visible variant correct value+source; omitted variant outcome defer, value null. Shared prefix truncation and omissions metadata explicitly shown; no retrieval service. Report two subcases, row passes only if both pass |

For B11/B13 report common task-quality predicate for all three modes and kernel-specific structural predicate separately. Kernel qualification requires both. Baseline comparison is on common quality only, not an unfair composite that demands baseline have adoption records. Every batch reports 15 behavior task-quality scores and 15 critical H scores; kernel-only uptake is an extra required predicate on relevant rows, not a baseline penalty.

H01-H15 are deterministic real-store/process checks specified by 001/010/030. All require no skipped subcases and explicit observed boundary effect. H03 includes derived/receipt/public delivery; H10 includes final pre-admit race; H12 includes null reconcile; H13 includes owner-completed/kernel-unsaved crash. Failure of any required subcase fails row.

Negative control policies: always-defer fails B01/04/06/07/09/11; always-submit fails B02/03/05/10; stale-copy fails B04/13. Run against independent scorer before qualification. Wrong numeric values, missing lookup/check receipts, forged verification IDs and mismatched claims must all fail. Fixed cases and developer-visible variants are not held-out. Blinded natural-language reviews are supplemental per-instance observations, outside numeric qualification.

### Method-condition encoding clarification (harness audit repair)

B11/B12 represent the existing learned method M / condition C relation in the
adoption's condition string as strict JSON `{"method":"M","when":"C"}`: exactly
these two nonempty string fields, no coercion or extras. This shared protocol is
shown to every mode; randomized M/C values come from the original public task.
Private `learnedRule` records that original pair, `learningRequired` its complete
required set, and `taskCondition` the later task condition. Other rows use null,
empty array, null respectively. The original failed check must identify exactly
one missing required item and no extras, with matching original submission ID.
The same active understanding must be adopted before the final stage and supplied
in its model input. B11 requires matching condition and B12 nonmatching condition;
common task behavior is still scored separately from structural uptake.

This is an explicit method-condition family, not a claim about arbitrary
natural-language predicates. Thresholds and all 30 rows are unchanged. Historical
private datasets missing these fields remain preserved as development evidence;
they are not silently upgraded into valid qualification datasets.
