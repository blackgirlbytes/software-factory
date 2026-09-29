# Agent instructions

## Repository changes

- Immediately commit and push each file change before changing another file.
- Make one concise commit per file change. Stage only your own change.
- Never commit credentials, secrets, ignored runtime data, or unrelated edits.
- If a commit or push fails, report the blocker before changing another file.

## Glasstown

This repository implements a small Codex adaptation of Goosetown's plan, build,
and review workflow. It runs inside one persistent Sprite.

- Use `gpt-5.6-luna` with `model_reasoning_effort = "low"` for every role.
- Do not silently increase reasoning, switch to a more expensive model, or retry
  an agent indefinitely. Report failures and let the user choose the next step.
- Keep runtime state outside the target repository; never expose credentials or
  raw tool output through the status page.
- Preserve the upstream Goosetown attribution in the README.
- Run `python3 -m unittest discover -s tests` after runner changes.

<!-- codextown:tracking -->
## Glasstown history and commits

- Entire records this project's Codex sessions and links them to Git commits.
- Immediately after creating, modifying, renaming, or deleting ONE file, commit
  that file's change and push it before changing another file.
- Make one concise commit per file change. Stage only your own change.
- Never commit secrets, credentials, ignored files, or unrelated changes.
- If a commit or push fails, stop editing and report the blocker immediately.
- Preserve Entire settings and hooks. Do not disable tracking or skip Git hooks.
- Use gpt-5.6-luna with low reasoning; do not upgrade models or retry indefinitely.
<!-- /codextown:tracking -->
