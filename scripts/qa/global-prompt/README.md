# Historical global prompt fixtures

These are synthetic regression inputs for a retired Senpi-backed prompt experiment.
The reference prompt has been anonymized for source distribution; it is not an
unmodified snapshot of a private installation. The executor was retired with the Codex-only transition;
there is no supported run command for these fixtures in this revision. They do
not describe the current application's provider configuration or establish
current Codex behavior.

The prompt variants and scenario files remain as historical research inputs.
The six cases in `holdout-cases.json` were revealed after v3 was frozen and are
now known regression inputs. Do not tune against them and describe them as unseen.
Private transcripts and historical execution results are not included. The cases
preserve comparison inputs, not measured results for the current runtime.

Current behavior is covered by Codex adapter/lifecycle tests, OpenCodex service
tests, and the live QA described in [runtime documentation](../../../docs/CODEX_RUNTIME.md).
Actual provider qualification needs a separately authorized isolated run.
