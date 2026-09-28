# Software Factory

The factory controller runs on your computer and manages one persistent Fly.io Sprite per project. Each Sprite holds that project's Git repository and coding tools. The controller keeps its project registry and Codex session IDs in ignored `.factory/state.sqlite3`. It reads `SPRITE_TOKEN` and `OPENAI_API_KEY` from ignored `.env.local`. The Fly token stays in the controller; the OpenAI key is sent through Codex's login input inside the Sprite, never in a command argument or Git commit.

## Run the controller

Use Node 24 or newer (see `.nvmrc`), then install dependencies with `npm ci`. Put `SPRITE_TOKEN=<your token>` and `OPENAI_API_KEY=<your key>` in `.env.local`.

```sh
node factory.mjs provision my-project
node factory.mjs bootstrap my-project
node factory.mjs codex-smoke my-project
node factory.mjs status my-project
node factory.mjs exec my-project -- git --version
node factory.mjs projects
```

`provision` saves the planned Sprite name before calling Fly, so retrying after an interruption reconnects to the same Sprite. `bootstrap` creates an empty repository at `/home/sprite/projects/<project-id>` unless you pass `--repo-url <git-url>` for an existing repository. It installs Entire CLI 0.11.3 and the official Codex CLI 0.158.0, enables Codex tracking, vets the hooks, commits the tracking configuration, and runs a Codex smoke test. The smoke test proves that Codex can execute a shell command and that Entire captured its session. Run `codex-smoke` to repeat that check without bootstrapping again.

The Codex hook check rejects unexpected user or project hook config. It allows only project trust entries in the user config and does not write Codex's hook trust records. The smoke test checks hook sources immediately before using `--dangerously-bypass-hook-trust` for that invocation, as described in the [Codex hook documentation](https://learn.chatgpt.com/docs/hooks). The Sprite's bundled Codex cannot launch its shell helper, so the factory uses the official CLI. The Sprite process inherits Linux capabilities that Bubblewrap rejects; the controller drops those capabilities with `setpriv` before launching Codex in its read-only sandbox.

This is the first setup milestone. The controller can provision, reconnect, execute commands, authenticate Codex, and verify session tracking. Research, planning, building, reviewing, scheduling, and tutorials remain to be implemented.
