# Agent instructions

## Factory entry point

When the user describes an app or product to build in this repository, use the
[Glasstown skill](.agents/skills/glasstown/SKILL.md), even if they do not name it.
Read that file before planning or creating the project. This repository is the
factory control plane; new products belong in their own Sprite project folders
and GitHub repositories. Requests to change the factory itself stay in this repo.

The standard workflow is: discuss the plan and constraints with the user, then
create a separate private project/repo for a new product (reuse the named project
for follow-up work), run low-reasoning workers with Entire tracking and per-file
commit/push, write and review `tutorial.md` in the project repo, open the approved web preview in Chrome, and return GitHub and Entire
links plus the tutorial link. The user should not need to repeat these defaults. Honor explicit overrides
and previously accepted plans; the skill contains the concrete setup and delivery
steps. Do not start a new product build before the planning conversation is settled
unless the user explicitly asks to proceed without it.

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
