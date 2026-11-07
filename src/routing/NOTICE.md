Vendored verbatim from jgraph/drawio commit f3abfe0f082c18f7b4fee8a34c2d07b1987687fd:

- src/main/webapp/js/libavoid-js/libavoid.min.js
- src/main/webapp/js/libavoid-js/libavoid-routing.js
- src/main/webapp/js/libavoid-js/LICENSE and README.md

The libavoid engine is LGPL-2.1; its license and upstream build/source instructions
are distributed in vendor/. The adapter in router.js is DrawAI code. The engine
is kept as a separate replaceable file, without changes to the upstream bundle.
The draw.io routing core is covered by draw.io's Apache-2.0 license, included as
vendor/DRAWIO-LICENSE. Copyright belongs to its upstream authors.
Upstream: https://github.com/jgraph/drawio-libavoid (source and build instructions).
Routing core: https://github.com/jgraph/drawio/tree/f3abfe0f082c18f7b4fee8a34c2d07b1987687fd/src/main/webapp/js/libavoid-js
