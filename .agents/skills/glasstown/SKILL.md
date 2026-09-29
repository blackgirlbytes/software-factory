---
name: glasstown
description: Plan and build a new project, or continue an existing project, through the Glasstown software factory in this repository. Handles the Sprite workspace, GitHub repo, Entire capture, bounded Codex workers, and Chrome preview. Use for product-building requests here; factory maintenance uses the normal repository workflow.
---

# Glasstown factory workflow

The user supplies an idea and constraints. Supply the factory defaults yourself;
do not make them repeat infrastructure, model, tracking, or delivery instructions.
Explicit user choices override these defaults.

## Discuss the project first

- For a new idea, discuss scope and constraints in this chat before running a
  build. Ask only questions that materially affect the product; propose sensible
  assumptions for the rest. Cover the first usable version, acceptance checks,
  design, required integrations, and exclusions as relevant.
- Present a concrete plan and let the user refine it. Begin building when they
  accept it. Prior approval counts; an explicit instruction to proceed without
  discussion also counts. Do not repeatedly ask for the same approval.
- Include the separate project/repo and default private visibility in the plan,
  so acceptance covers creating and pushing that repo. No separate confirmation
  is needed for each standard factory step.
- For a named existing project, preserve its requirements and repo. Discuss
  ambiguous or substantial scope changes; carry out clearly specified edits
  without repeating a full discovery interview.
- This conversation is the interactive planning stage. The runner's planner is
  an implementation pass; it does not pause to interview the user.

## Defaults you own

- Each new product gets its own folder under `/home/sprite/projects/` and its
  own **private GitHub repository**. The factory checkout is never the target
  application. Do not overwrite or repurpose an old project for a new idea.
- Continue an existing product in its existing folder/repo. Inspect the available
  projects and remotes to identify it; ask only if the match is ambiguous.
- Reuse the configured Sprite `mcp-rizel-codextown`. Separate folders share the
  Sprite's resources; do not describe them as isolated machines. Creating a new
  Sprite is a separate setup workflow when the user requests it.
- Use the factory's `gpt-5.6-luna` / **low reasoning** settings for all worker
  roles. No silent model upgrades, higher reasoning, or unbounded retries.
- Enable Entire before any product worker runs, retain its hooks and transcripts,
  and commit then push **each individual file change** before the next file.
- Have the tutorial writer create/update and push `tutorial.md` from the actual
  implementation before final review. Return its GitHub link with the results.
- For a web app, run the final preview, connect its private local tunnel, and
  open **Google Chrome**. Always return the GitHub and Entire links when available.
- Preserve existing projects, running previews, credentials, and unrelated work.
  No public deployment, public repo, or public Sprite URL is implied.

## Prepare the environment and project

Read the factory [README](../../../README.md) for current runtime and CLI details.
The local checkout is the control plane; `/home/sprite/software-factory` is the
factory checkout inside the Sprite. Legacy `codextown` filenames are intentional.

1. Check the local Sprites CLI and access to the configured Sprite. It may be at
   `~/.local/bin/sprite`. For remote commands use
   `sprite exec -s mcp-rizel-codextown --no-port-forward --no-stdin -- COMMAND ...`.
   Check GitHub login, Git identity, Entire availability, and Codex login status
   inside the Sprite. Use `/home/sprite/software-factory/codex-sprite.sh` for
   Codex; the preinstalled bare Codex executable is not the configured runtime.
   Never print or copy credentials. Reuse working authentication; ask for login
   only if a check actually fails.
2. Check the Sprite factory checkout for local changes before bringing it up to
   date with a fast-forward pull. Preserve dirty work and report a blocker rather
   than resetting it. Do not interrupt a running factory task to update its code.
3. For a new product, choose a descriptive slug, check both the project directory
   and GitHub name for collisions, and derive the owner from the authenticated
   GitHub account unless the user named an organization. Choose an unused suffix
   for an unrelated collision; never overwrite an existing repo. Initialize a
   Git repo on `main` inside the new Sprite folder and use `gh repo create` with
   `--private --source PROJECT_PATH --remote origin`. Quote arguments safely.
   Do not create files in the factory checkout as a substitute for this project.
4. Run `python3 /home/sprite/software-factory/codextown.py prepare --repo PROJECT_PATH`
   inside the Sprite. This supports an empty repo with a pushable remote. It
   enables Entire for Codex, installs Git and agent hooks, adds the project's
   tracking instructions, and commits/pushes each setup file separately. Use
   this helper instead of an ad hoc `entire enable -y` that bypasses those rules.
5. Save the agreed scope, constraints, exclusions, and acceptance checks in the
   target project's `PROJECT_BRIEF.md`; for an existing project preserve its
   existing brief and update it only as needed. Commit and push this file before
   touching another file. Do not put secrets in the brief. Include the brief and
   any later accepted changes in the task sent to the workers. The chat's planning
   transcript is not automatically copied into the remote worker session, so the
   written brief is essential context.

## Build and deliver

- On the **Mac**, from this factory checkout, run:

  ```sh
  python3 codextown_client.py --repo /home/sprite/projects/PROJECT_SLUG "TASK_WITH_AGREED_CONSTRAINTS"
  ```

  Replace the placeholders with the actual project and accepted brief. Supply
  prompt text as a safely quoted argument; do not interpolate unescaped user
  text into shell code. Do not ask the user to run this command themselves.
- The runner prepares tracking, plans, builds, verifies pushed commits and Entire
  trailers, writes and pushes `tutorial.md`, reviews both code and tutorial, syncs sessions, and starts an approved app's preview. The Mac
  client connects the tunnel and opens Chrome. Running only the remote runner
  does not complete the browser-opening part of delivery.
- Keep the client/tunnel process alive after Chrome opens. Report its actual
  preview URL and run ID. A local tunnel closing does not delete the project.
- Wait for the actual result; do not call a dispatched run complete. Inspect
  `needs_changes`, failed runs, or failed previews and explain the specific
  blocker. Preserve work, do not retry indefinitely, and do not report an app as
  ready unless the preview health check passed. Respect the user's authorization
  when deciding the next bounded repair task; never silently increase cost.
- Return a concise result with **app preview**, **GitHub project/commit**, and
  **Entire sessions**, and **tutorial** links from the run's `links` metadata. Those GitHub/Entire
  links should still be returned for a skipped or failed web preview when present.
  Non-web projects get artifact locations instead of a forced web server. Entire
  may require sign-in/repo access or time to ingest a new checkpoint.
- Open Chrome through the existing client or the OS URL opener; do not use
  computer-use automation to open it. Do not expose credentials or raw transcripts
  through the dashboard.
- For a return visit, identify the correct saved run and use
  `python3 codextown_client.py --open-run RUN_ID` to reopen it without new model
  calls. Do not guess the run ID or reuse an unrelated app's localhost port.

The skill orchestrates the new-project setup and planning conversation. The
Python runner still requires an existing target repo and does not itself create
Sprites, interview the user, or provide back-and-forth worker chat.
