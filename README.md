# Codextown on Sprites

A small Codex adaptation of [Goosetown](https://github.com/aaif-goose/goosetown):
one planner, one worker, one reviewer, a final preview worker, and a live Town Wall
inside a persistent Sprite. This is an initial implementation of that workflow, not a complete port
of Goosetown's Goose extensions or dashboard.

## Cost defaults

All three roles use **`gpt-5.6-luna` with low reasoning**. The runner explicitly
sets the model, effort, and default service tier on each invocation, overriding
profile defaults for those choices. It retains Codex login
credentials. There is no automatic model upgrade, retry loop, or repair loop.
One run makes at most three agent calls, each limited to five minutes by default.
Timeouts bound duration, not dollar spend. Account usage and billing depend on
how Codex is authenticated.
The fourth, preview worker uses ordinary code and makes no additional model call.

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

## Give a task and open the finished app in Chrome

Run this **on your Mac**, from your local checkout of this repository:

```sh
python3 codextown_client.py --repo /home/sprite/projects/my-project \
  "Build a small web app and run its tests"
```

The project path is inside the Sprite and must already be a clean Git repository.
The client sends your task to Codextown, streams progress, and waits for a passed
review. The preview worker starts the app and checks its HTTP response. The client
then connects a private local port and opens **Google Chrome** automatically.
It picks an unused local port, so an existing localhost:3000 app is unaffected.
Keep that terminal open while viewing the app; Ctrl+C closes the local connection.
On other desktop platforms, the client opens the default browser.

The Sprites CLI must be installed and signed in on that computer (`sprite login`).
This is separate from Codex's login inside the Sprite. Both are already set up on
the current Mac/Sprite. The client also looks for `~/.local/bin/sprite` when it is
not on PATH. Use `--sprite NAME` or `--org NAME` to select another environment.

Reopen an existing preview without rerunning any agents:

```sh
python3 codextown_client.py --open-run RUN_ID
```

The client prints the run ID and preview URL. Reopening supports the 30 most recent
runs. It starts that run's Sprite service again if necessary; a later modification
to the same project will also change what that preview serves.

### What the preview worker supports

- Node projects with a `dev` or `start` script. Next.js and Vite get explicit
  loopback host/port flags; other scripts should honor `PORT` and `HOST`.
- Static sites with `dist/index.html` or a root `index.html`. The built-in server
  blocks hidden files, directory listings, and symlinks outside the served folder.
- Custom servers with `--preview-command`, for example
  `--preview-command 'python3 app.py' --preview-port 5000`. Commands run in the
  target project with `PORT` and `HOST` set. The app must listen on that port.

The worker has 60 seconds to receive a successful HTTP response after starting
the server. This is a readiness check, not a visual or interaction test. A failed
review never starts a preview. A preview failure stops with exit 3 and retains
the successful code review; inspect `preview-error.txt`, `preview.log`, and the
Sprite service logs. Non-web tasks skip preview. Use `--no-preview` with the
inside-Sprite runner to disable this step explicitly.

Each successful run leaves a named `codextown-preview-RUN_ID` Sprite service.
The dashboard shows its preview port; its existing private URL still serves the
town board. No public URL setting changes. To retire a preview, run inside the
Sprite:

```sh
sprite-env services stop codextown-preview-RUN_ID
sprite-env services delete codextown-preview-RUN_ID
```

Use the lowercase run ID for the service name. Logs are under
`/.sprite/logs/services/codextown-preview-RUN_ID.log`.

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
implements, commits and pushes each file change, and tests. The reviewer
independently inspects the committed diff from the run's starting commit. A rejected
review stops with `needs_changes`; errors stop with `failed`. Inspect the
artifacts before deciding whether to run another task. A clean-repository check
prevents a new run from silently building over uncommitted work.

## Entire history for every project

Every project submitted to Codextown is prepared automatically before any model
calls. This also works for an empty Git repository with a configured remote.
Setup requires Entire on the Sprite, a Git author identity, a push remote (the
branch's remote, or `origin`), and working Git authentication. The current Sprite
has Entire 0.11.3 and GitHub authentication configured.

Codextown preserves existing project instructions and adds a managed `AGENTS.md`
section requiring **one file change → commit → push → next file**. It installs
Entire's generated Codex hooks, enables automatic commit linking and session
sync, and keeps logs and machine-local settings ignored. Setup itself commits
and pushes each shared configuration file separately. A failed push stops setup
before another file is changed.

The runner retains Codex transcripts instead of using ephemeral sessions. A
dedicated local Codex profile approves only hook definitions generated by the
installed Entire CLI; unrelated hooks are not automatically approved. Explicit
model and reasoning flags remain fixed. The worker gets write access to the
project's Git metadata and network access for pushes; planner and reviewer stay
read-only. A final push syncs session records after review finishes.

Before review, Codextown checks that the worker left a clean tree, pushed its
commits, changed only one file per commit, and attached an `Entire-Checkpoint`
trailer to each new commit. Failures stop the run before preview. Read-only roles
retain Codex transcripts; source-changing commits are what create Entire's
commit-linked checkpoints. The preview worker is ordinary code, not another
Codex conversation.

To prepare a project without starting a model, run inside the Sprite:

```sh
python3 /home/sprite/software-factory/codextown.py prepare \
  --repo /home/sprite/projects/my-project
```

To inspect recorded work from that project's terminal:

```sh
entire session list --json
entire checkpoint list --json --no-pager
git log -5 --format=full
```

For a new Sprite, install Entire using its [official installation guide](https://docs.entire.io/installation),
sign in with `gh auth login` and `gh auth setup-git`, and configure your Git name
and email. Projects must have a remote you can push to. No credentials are copied
into project files. Tracking is configured per project when Codextown prepares it;
unrelated repositories elsewhere in the Sprite are not modified.

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
