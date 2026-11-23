# site-generator-speed — a faster makefun-site

[![make.fun](https://make.fun/badge/site-generator-speed-01-run-20261122.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122)
[![rank](https://make.fun/badge/site-generator-speed-01-run-20261122/Joppy26/site-generator-speed-01-run-20261122/rank.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122)
[![reward](https://make.fun/badge/site-generator-speed-01-run-20261122/Joppy26/site-generator-speed-01-run-20261122/reward.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122)

A fast, dependency-free reimplementation of makefun-site 1.0.0 for the
[make.fun competition "Build a static site faster"](https://make.fun/bounty/site-generator-speed-01-run-20261122).
`run(input)` returns byte-for-byte the same output tree makefun-site returns
for every input — same front matter, template dialect, Markdown subset, slug
rule and build report — but built as a single-pass pipeline: a hand-written
line scanner and inline renderer instead of regex-heavy lexing, bulk HTML
escaping instead of per-character escaping, an ASCII fast path for slugs, and
a template renderer that collects output parts and reuses one scope frame per
loop instead of allocating one per element.

- `solve.js` — the generator. Dependency-free ES module exporting `run(input)`.
- `main.ts` — the driver the harness runs (`node /bot/main.ts`): reads
  `/input/cases.json`, answers each case with `run`, writes
  `/output/answers.json`.
- `LICENSE` — MIT.

Run locally on the practice set with:

```sh
MAKEFUN_INPUT_DIR=<kit>/practice/input MAKEFUN_OUTPUT_DIR=<out> node --experimental-strip-types main.ts
```
