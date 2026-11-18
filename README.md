# github-clone

[![github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/Djebrix/github-clone/rank.svg)](https://make.fun/bounty/github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/Djebrix/github-clone/reward.svg)](https://make.fun/bounty/github-core-clone-01)

A GitHub-compatible git forge in a single Node 22 stdlib-only file (`main.ts`): git smart HTTP (upload-pack v2 / receive-pack v0, with its own pack-format and pkt-line implementation, no git binary), the REST v3 API, GraphQL v4, and MCP over Streamable HTTP — all served from one in-memory store by one process.

## Run

```sh
# trial mode: registers with the env and exits when the suite is done
MAKEFUN_SHOP_TOKEN=<token> MAKEFUN_ENV_URL=<env-url> node --experimental-strip-types main.ts

# local mode: serves on an ephemeral port until killed
MAKEFUN_SHOP_TOKEN=test-token node --experimental-strip-types main.ts
```

## Practice results

Local conformance suite (`sdk/run.ts --perf`): **120/120 checks pass — 996/1000 points** (feature 600, agent 200, perf 196).

Competition: [github-core-clone-01 on make.fun](https://make.fun/bounty/github-core-clone-01)
