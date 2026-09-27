# Software Factory

The factory controller runs on your computer and manages one persistent Fly.io Sprite per project. Each Sprite holds that project's Git repository and coding tools. The controller keeps its project registry in ignored `.factory/state.sqlite3` and reads `SPRITE_TOKEN` from ignored `.env.local`; the token is never sent into a Sprite.

## Run the controller

Use Node 24 or newer (see `.nvmrc`), then install dependencies with `npm ci`. Put `SPRITE_TOKEN=<your token>` in `.env.local`.

```sh
node factory.mjs provision my-project
node factory.mjs bootstrap my-project
node factory.mjs status my-project
node factory.mjs exec my-project -- git --version
node factory.mjs projects
```

`provision` saves the planned Sprite name before calling Fly, so retrying after an interruption reconnects to the same Sprite. `bootstrap` creates an empty repository at `/home/sprite/projects/<project-id>` unless you pass `--repo-url <git-url>` for an existing repository. It installs Entire CLI 0.11.3, enables Codex and Claude Code tracking, checks the generated Codex hooks against a vetted fingerprint, runs `entire doctor`, and commits the tracking configuration. Repeating it is safe.

The Codex hook check rejects unexpected user or project hook config. It does not grant persistent hook trust. An unattended Codex adapter will need to recheck hook sources immediately before each launch and use `--dangerously-bypass-hook-trust` for that invocation, as described in the [Codex hook documentation](https://learn.chatgpt.com/docs/hooks).

This is the first setup milestone. The controller can provision, reconnect, execute commands, and bootstrap session tracking. Running coding agents still requires separate Codex or Claude Code authentication inside the Sprite; a Sprites token only authorizes Sprite management. Research, planning, building, reviewing, scheduling, and tutorials remain to be implemented.
