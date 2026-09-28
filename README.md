# Software Factory

The factory controller runs on your computer and manages one persistent Fly.io Sprite per project. Each Sprite holds that project's Git repository and coding tools. The controller keeps its project registry and Codex session IDs in ignored `.factory/state.sqlite3`. It reads `SPRITE_TOKEN` and `OPENAI_API_KEY` from ignored `.env.local`. The Fly token stays in the controller; the OpenAI key is sent through Codex's login input inside the Sprite, never in a command argument or Git commit.

## Run the controller

Use Node 24 or newer (see `.nvmrc`), then install dependencies with `npm ci`. Put `SPRITE_TOKEN=<your token>` and `OPENAI_API_KEY=<your key>` in `.env.local`. The local GitHub CLI must be authenticated to create private project repositories and register deploy keys.

```sh
node factory.mjs provision my-project
node factory.mjs bootstrap my-project
node factory.mjs codex-smoke my-project
node factory.mjs codex-file my-project README.md -- 'Write a project introduction'
node factory.mjs status my-project
node factory.mjs exec my-project -- git --version
node factory.mjs projects
```

`provision` saves the planned Sprite name before calling Fly, so retrying after an interruption reconnects to the same Sprite. For a new project, `bootstrap` initializes `/home/sprite/projects/<project-id>`, creates a separate private GitHub repository named after its Sprite, and registers a write-enabled deploy key scoped to that repository. Your GitHub account token stays on the controller; only the project deploy key is stored in the Sprite. Bootstrap installs Entire CLI 0.11.3 and Codex CLI 0.158.0, enables Codex tracking, vets the hooks, installs [the generated agent rules](templates/AGENTS.md), pushes the initial commits, configures checkpoint syncing to `origin`, and runs a Codex smoke test. Repeating bootstrap reconciles the same Sprite and remote. Passing `--repo-url <git-url>` instead clones an existing repository; it does not install the factory's rules or create a new GitHub remote there.

`codex-file` is the first bounded build operation. Codex changes one named file in its writable sandbox, then stops. Because that sandbox protects `.git`, the controller stages only that file, commits it, pushes `main`, and records the Codex session and Entire checkpoint IDs before another file task starts. It refuses a dirty working tree or a run that changes a different number of files. `codex-smoke` repeats the read-only shell and session-capture check.

The Codex hook check rejects unexpected user or project hook config. It allows only project trust entries in the user config and does not write Codex's hook trust records. The smoke test checks hook sources immediately before using `--dangerously-bypass-hook-trust` for that invocation, as described in the [Codex hook documentation](https://learn.chatgpt.com/docs/hooks). The Sprite's bundled Codex cannot launch its shell helper, so the factory uses the official CLI. The Sprite process inherits Linux capabilities that Bubblewrap rejects; the controller drops those capabilities with `setpriv` before launching Codex in its read-only sandbox.

The controller can now provision, reconnect, authenticate Codex, create private project remotes, push code and Entire checkpoints, and complete one-file agent tasks. Research, planning, multi-file building, reviewing, scheduling, and tutorials remain to be implemented.
