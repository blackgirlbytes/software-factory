# Codextown on Sprites

A small Codex adaptation of [Goosetown](https://github.com/aaif-goose/goosetown):
one planner, one worker, one reviewer, and a live Town Wall inside a persistent
Sprite. This is an initial implementation of that workflow, not a complete port
of Goosetown's Goose extensions or dashboard.

## Cost defaults

All three roles use **`gpt-5.6-luna` with low reasoning**. The runner explicitly
sets the model, effort, and default service tier on each invocation, ignoring
user configuration that could override those choices. It retains Codex login
credentials. There is no automatic model upgrade, retry loop, or repair loop.
One run makes at most three agent calls, each limited to five minutes by default.
Timeouts bound duration, not dollar spend. Account usage and billing depend on
how Codex is authenticated.

## Current environment

- Sprite: `mcp-rizel-codextown` (one Sprite; the connector permits up to three)
- Checkout: `/home/sprite/software-factory`
- Dashboard service: `codextown-dashboard`, port `8080`
- [Private Sprite URL](https://mcp-rizel-codextown-b3kwj.sprites.app)
- Model access requires signing in to Codex **inside the Sprite**.

Sprites MCP manages the environment. Codex runs locally inside that environment.
The dashboard URL retains Sprite authentication. If using the Sprites CLI,
`sprite proxy -s mcp-rizel-codextown 8080` provides local browser access after
signing in to the same organization.

## Run a task inside the Sprite

Requires Python 3.10+, Git, and a Codex CLI supporting `--ignore-user-config`.
The initial Sprite supplies Python 3.13. Its preinstalled Codex executable lacks
the Code Mode helper, so use the complete official npm package in a separate
runtime directory:

```sh
cd /home/sprite/software-factory
npm install --prefix "$HOME/.local/share/codextown-runtime" @openai/codex@0.151.0
export CODEXTOWN_CODEX=/home/sprite/software-factory/codex-sprite.sh
"$CODEXTOWN_CODEX" login --device-auth
python3 codextown.py run --repo /path/to/target-repository \
  "Implement a small feature and run its tests"
```

The current Sprite already has this package and a completed Codex login. For
later sessions, export `CODEXTOWN_CODEX` as above; installation and login only
need repeating when the runtime or credentials need replacing.
The launcher drops the Sprite exec session's inherited Linux capabilities so
Codex's Bubblewrap sandbox can start. It preserves the per-role sandbox settings.

The target must be a clean Git repository. Existing `AGENTS.md` instructions
remain authoritative. The planner and reviewer use read-only sandboxes; the
worker uses workspace-write. Agents may run shell commands and access network
services available to them. There is no automated deployment step.

The planner produces an implementation plan and acceptance checks. The worker
implements and tests. The reviewer independently inspects the result. A rejected
review stops with `needs_changes`; errors stop with `failed`. Inspect the
artifacts before deciding whether to run another task. A clean-repository check
prevents a new run from silently building over uncommitted work.

```sh
python3 codextown.py status
python3 codextown.py serve --host 0.0.0.0 --port 8080
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s tests
```

The HTTP service is read-only. It exposes only `/`, `/health`, and `/api/status`,
not arbitrary files, raw tool transcripts, or credentials. It relies on the
private Sprite URL for external access control. Bind to localhost when running
outside that protected environment.

## State and lifecycle

Run metadata, final responses, raw JSONL events, stderr, and structured reviews
live under `~/.local/state/codextown/runs/`, outside the target repository. The
Town Wall reports phase transitions; it is not yet a bidirectional agent bus.
Each repository has an exclusive lock so two runs cannot edit it concurrently.

Sprite storage preserves artifacts across restarts. The dashboard runs as a
Sprite service so it can restart after wake-up. Agent runs are bounded foreground
processes: interrupted work is reported, not silently resumed or retried. No
continuous background queue or always-running agent is installed. The dashboard
marks running metadata as interrupted when the controller is no longer alive.

## Relationship to Goosetown

The research/build/review roles and Town Wall concept are inspired by Goosetown.
This repository's runner and UI are newly authored; no upstream source code is
vendored. Goosetown's parallel flocks, urgent messaging, knowledge catalog,
Beads integration, and cross-model review are not implemented in this prototype.
We start with one worker and one review to validate Codex on a Sprite at low cost.
