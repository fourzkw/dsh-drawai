ClipCard.tsx is copied from video-shotcraft by Vincentwei1021:
https://github.com/Vincentwei1021/video-shotcraft/blob/main/assets/lib/ClipCard.tsx

Upstream code is licensed under Apache-2.0; see LICENSE in this directory.
DrawAI modification: added a `fit` prop to retain the full reference video frame.
DrawAI's entry.jsx and its other motion modules are independent adapter code.
No upstream music, sound effects, or third-party media are distributed.

The source-only upstream/ tree is pinned to commit
1266a3ec4831289c4d893d42dd5102723658039a of the same repository.
It includes all 124 current recipe cards, 150 style entries, corresponding
demo/shared-component sources, template sources, and production references.
upstream/manifest.json records the original SHA-256 of every copied file.
These files are unmodified; gallery preview videos, retired demos, screenshots,
fonts, music, and sound recordings are not redistributed. The native DrawAI
adapter reads the references; it does not run their shell/automation instructions.
Refresh with: node tools/vendor-shotcraft.mjs <upstream-checkout>.
