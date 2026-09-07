# UI component provenance

Lina adapts shadcn/ui's MIT-licensed `base-nova` component compositions, retrieved
on 2026-09-07, to named exports and the existing semantic CSS tokens. Base UI owns
interactive behavior; no Tailwind framework or shadcn CLI runtime is bundled.

The registry response has no immutable Git revision field. These SHA-256 digests
pin the exact retrieved snapshots; they must not be presented as an upstream Git
commit. Button, dropdown-menu, tabs and avatar patterns informed the local
wrappers. The input snapshot was inspected but not copied as a separate component.
Combobox uses the installed Base UI 1.8.0 API and its own Lina adapter.

| Registry snapshot | SHA-256 |
| --- | --- |
| [input.json](https://ui.shadcn.com/r/styles/base-nova/input.json) | `bbad1bba130ac9750a61844eeb8f043e8a710846e07689fa85398b80a46c2741` |
| [button.json](https://ui.shadcn.com/r/styles/base-nova/button.json) | `9ba7e870178813f0552b818a913a2792fb500c779e36395740b4973e3025d427` |
| [tabs.json](https://ui.shadcn.com/r/styles/base-nova/tabs.json) | `b4552a0329dd9a6e2bfaf03405c133874df5a4930c7bb3dd84c9ab5c45b89402` |
| [avatar.json](https://ui.shadcn.com/r/styles/base-nova/avatar.json) | `bbcabf0121fb2ff93a8522f8f80b74631e732a31399b1b7991c0b8c3167e2172` |
| [dropdown-menu.json](https://ui.shadcn.com/r/styles/base-nova/dropdown-menu.json) | `335c59dba30145f434a9cc9ccb0438a3c5e2afe857fc11b029de1ecb415224d7` |

Runtime versions are pinned in `package.json` and the workspace `bun.lock`.
React 19.2.8, React DOM 19.2.8 and Base UI 1.8.0 are new dependencies of this UI
package. `THIRD_PARTY_LICENSES.txt` preserves their distributed licenses, relevant
transitive dependency licenses and the shadcn MIT notice. `lina-web/src/assets.ts`
includes these notices in the JS served on web and bundled into Electron.
