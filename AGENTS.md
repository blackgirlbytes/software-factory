# Agent instructions

## Repository changes

- Immediately commit and push each file change before changing another file.
- Make one concise commit per file change. Stage only your own change.
- Never commit credentials, secrets, ignored runtime data, or unrelated edits.
- If a commit or push fails, report the blocker before changing another file.

## Codextown

This repository implements a small Codex adaptation of Goosetown's plan, build,
and review workflow. It runs inside one persistent Sprite.

- Use `gpt-5.6-luna` with `model_reasoning_effort = "low"` for every role.
- Do not silently increase reasoning, switch to a more expensive model, or retry
  an agent indefinitely. Report failures and let the user choose the next step.
- Keep runtime state outside the target repository; never expose credentials or
  raw tool output through the status page.
- Preserve the upstream Goosetown attribution in the README.
- Run `python3 -m unittest discover -s tests` after runner changes.
