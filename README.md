# Software Factory

The factory controller can run locally or as a supervised service in its own Fly.io Sprite. It manages one persistent Sprite per project; each project Sprite holds its Git repository and coding tools. The controller keeps its project registry and Codex session IDs in ignored `.factory/state.sqlite3`. It reads `SPRITE_TOKEN` and `OPENAI_API_KEY` from ignored `.env.local`. The Fly token stays in the controller; the OpenAI key is sent through Codex's login input inside the project Sprite, never in a command argument or Git commit.

## Run autonomously in a Sprite

`control.mjs` deploys the controller to the private `sf-software-factory-control` Sprite. Its supervised service accepts jobs on a loopback-only port, saves them in SQLite, and invokes Codex inside each project's separate Sprite. The local command can exit after submission; the service resumes queued or interrupted work after restart. During a run it creates a renewable Sprite task to keep its controller awake.

```sh
node control.mjs deploy
node control.mjs submit my-project --request 'Build a useful app for ...'
node control.mjs submit another-project --request 'Rebuild this product ...' --reference-path /path/to/reference-repo
node control.mjs jobs
node control.mjs status <job-id>
node control.mjs resume <blocked-job-id>
```

Deployment copies committed factory source, installs dependencies, and restarts the service. The first deployment imports the local controller database when present; later deployments preserve the remote database. It writes a mode-0600 credential file in the **controller** Sprite containing the Fly and OpenAI keys plus a GitHub token from `GITHUB_TOKEN` or the authenticated local `gh` CLI. Project Sprites do not receive that GitHub account token. Put `TYPESAFE_API_KEY` in the factory's ignored `.env.local` to enable Jev scheduling remotely. A submitted reference repository is converted locally to a bounded tracked-source snapshot before upload; credentials and ignored files are excluded.

Only one job runs at a time in this first supervisor. An exhausted Codex quota leaves the job queued for a slow, durable retry (one to six hours between attempts); `control.mjs resume <job-id>` can retry sooner after credits are restored. The supervisor holds a Sprite task lease while work is queued, including during retry delays, so it remains awake until the job runs; that consumes Sprite runtime. Missing credentials remain blocked, and transient transport failures get at most three attempts. `run-status` inside the job response includes project tasks and checkpoints. The Girl Dinner validation is queued at review after the Codex API reported exhausted credits, so the new autonomous path has not yet completed a product run.

Plans for new runs now require each blocking acceptance criterion to cite exact request or reference text. An independent read-only Codex scope audit challenges inferred requirements before building. Optional product ideas are recorded separately and must not become required checks. Older runs with unsourced plans, including the current Girl Dinner rebuild, amend and audit their plan before review resumes, then rerun verification against the amended contract.

## Run the controller

Use Node 24 or newer (see `.nvmrc`), then install dependencies with `npm ci`. Put `SPRITE_TOKEN=<your token>` and `OPENAI_API_KEY=<your key>` in `.env.local`. The local GitHub CLI must be authenticated to create private project repositories and register deploy keys.

```sh
node factory.mjs provision my-project
node factory.mjs bootstrap my-project
node factory.mjs codex-smoke my-project
node factory.mjs codex-file my-project README.md -- 'Write a project introduction'
node factory.mjs run my-project --request 'Build a useful app for ...' --reference-path /path/to/reference-repo
node factory.mjs run-status my-project
node factory.mjs status my-project
node factory.mjs exec my-project -- git --version
node factory.mjs projects
```

`provision` saves the planned Sprite name before calling Fly, so retrying after an interruption reconnects to the same Sprite. For a new project, `bootstrap` initializes `/home/sprite/projects/<project-id>`, creates a separate private GitHub repository named after its Sprite, and registers a write-enabled deploy key scoped to that repository. Your GitHub account token stays on the controller; only the project deploy key is stored in the Sprite. Bootstrap installs Entire CLI 0.11.3 and Codex CLI 0.158.0, enables Codex tracking, vets the hooks, installs [the generated agent rules](templates/AGENTS.md), pushes the initial commits, configures checkpoint syncing to `origin`, and runs a Codex smoke test. Repeating bootstrap reconciles the same Sprite and remote. Passing `--repo-url <git-url>` instead clones an existing repository; it does not install the factory's rules or create a new GitHub remote there.

`codex-file` is the first bounded build operation. Codex changes one named file in its writable sandbox, then stops. Because that sandbox protects `.git`, the controller stages only that file, commits it, pushes `main`, and records the Codex session and Entire checkpoint IDs before another file task starts. It refuses a dirty working tree or a run that changes a different number of files. `codex-smoke` repeats the read-only shell and session-capture check.

The Codex hook check rejects unexpected user or project hook config. It allows only project trust entries in the user config and does not write Codex's hook trust records. The smoke test checks hook sources immediately before using `--dangerously-bypass-hook-trust` for that invocation, as described in the [Codex hook documentation](https://learn.chatgpt.com/docs/hooks). The Sprite's bundled Codex cannot launch its shell helper, so the factory uses the official CLI. The Sprite process inherits Linux capabilities that Bubblewrap rejects; the controller drops those capabilities with `setpriv` before launching Codex in its read-only sandbox.

`run` provisions and bootstraps a project when needed, then uses Codex inside its Sprite to commit `RESEARCH.md` and a `PLAN.md` with acceptance criteria and a dependency graph. It executes each one-file task, runs the plan's checks, reviews the result against the request and Entire sessions, makes bounded one-file fixes, commits `REVIEW.md` and `TUTORIAL.md`, and returns a repository or Sprite web-service delivery. Repeat the same command after a failure to resume its saved run. `run-status` shows task commits, checkpoints, stage, errors, and scheduler decisions. The reference path is a local Git repository used only as read-only source material; it is not the output repository.

Set `TYPESAFE_API_KEY` in the controller environment to let Jev choose between ready independent tasks. The controller enforces dependencies and file ownership, requires at least 0.80 confidence for parallel work, and otherwise runs sequentially. Parallel builds use separate Sprite Git worktrees and push their branches before integration. No TypeSafe key is sent to a Sprite or committed. The workflow needs real product and integration checks before claiming a finished build; its first full validation is the Girl Dinner rebuild.
