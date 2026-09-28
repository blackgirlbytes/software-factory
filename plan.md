# Software Factory: Sprite Setup and Build Workflow

## Goal

Build a software factory that can take an open-ended request, research it, plan the work, implement it, review the result against the recorded intent, and produce a tutorial. Girl Dinner is the first end-to-end test, not a template or special case in the factory.

The factory creates and prepares a Fly.io Sprite for each project. A Sprite is the project's persistent development computer. The factory controller runs outside that Sprite so it can track projects and recover an environment even if an agent breaks its workspace.

## Architecture decisions

- **Factory controller:** Owns the user interface, project and run records, task scheduling, Fly.io credentials, GitHub repository creation, and Git commits and pushes for sandboxed Codex runs. Start it locally for the interview. Store a mapping from project ID to Sprite name, repository, current run, and checkpoint IDs.
- **Sprite control:** Use the Sprites SDK or REST API for routine create, inspect, execute, checkpoint, and service operations. The hosted Sprites MCP server is optional for an orchestrator that needs to request additional Sprite operations; it is not required for normal provisioning.
- **Project Sprite:** Holds the repository, installed tools, agent runtime, Entire configuration, session history, and development services. Reuse it for later requests on the same project. Its disk persists across sleep; long-running processes need a restart strategy after a cold wake.
- **Agent roles:** An orchestrator directs research, planning, building, review, and tutorial writing. Roles describe responsibilities, not fixed app types or a particular coding harness. A web app, CLI, API, or existing repository can follow the same workflow with different tasks and verification.
- **Coding harness:** Use Codex inside each Sprite. Keep its process and session handling behind a small controller interface so the workflow is independent of Codex-specific flags, but do not build other harness adapters now. A Codex run must pass a session-capture check before the factory promises intent-based review.
- **Jev:** Helps choose among bounded scheduling options for tasks that are ready to run. Code enforces task dependencies and file ownership. Jev does not write the plan or override a dependency.
- **Entire:** Records agent sessions and links their intent to commits. The factory also stores its own run IDs and agent session IDs so it can retrieve the right history for review.

## One-time factory setup

1. Configure a Fly.io organization and a Sprites API token for the controller. Keep the token outside project repositories and outside agent prompts.
2. Authenticate the local GitHub CLI. The controller creates private output repositories and registers a write-enabled deploy key scoped to each repository; the account token stays outside the Sprite.
3. Install a known official Codex CLI version in each Sprite and authenticate it with an OpenAI API key supplied by the controller through login input. Keep the key out of command arguments, prompts, and Git. Verify that Codex can actually run shell commands; a successful text reply alone is insufficient.
4. Install or package a known version of the factory's Sprite bootstrap script. The controller records the bootstrap version used for each project.
5. Create a small controller database for projects, runs, tasks, agent sessions, commits, checkpoints, and external resources. A local SQLite database is sufficient for the first version.

## Project Sprite bootstrap

The controller performs these steps when a new project is requested. Each step should be safe to retry after a failure.

1. Create a Sprite with a stable project-derived name and save that name immediately in the controller database. On later runs, reconnect to the existing Sprite.
2. Verify the base tools needed for the request. Install Git, Entire, Codex, and project-specific runtimes or packages as needed. Avoid assuming every product uses Node.js.
3. For new work, create a private GitHub output repository, initialize Git in the Sprite, register a repository-scoped deploy key, and connect `origin`. Clone an existing repository only when explicitly supplied as the target. Keep a reference repository separate from the output repository when rebuilding an existing product.
4. Enable Entire **before** starting coding-agent sessions. `entire enable --agent codex --no-init-repo` installs Codex's project `.codex/hooks.json`. Run `entire status --json` and `entire doctor` to check setup and hook drift.
5. Install a generic `AGENTS.md` in every factory-created repository and push it. It requires a commit and push after each file change. For interactive Codex runs, review and trust hooks through `/hooks`. For fully automated runs in a factory-controlled Sprite, inspect every effective hook source and allow only expected definitions before launching with `--dangerously-bypass-hook-trust`. That flag applies to one invocation and does not grant persistent trust. Do not write Codex's internal trust hashes directly. The bundled Codex is missing a shell helper, so use the official CLI. Drop the Sprite process's inherited Linux capabilities with `setpriv` before launching Codex; this lets its Bubblewrap sandbox run. Use a read-only sandbox for research and smoke tests and `workspace-write` for one-file edits. Because `.git` is protected in that sandbox, the controller stages only that file, commits it, pushes it, and records its Entire checkpoint before starting another file task.
6. Run a short tracked Codex smoke test that executes a shell command and confirm that Entire captured its session. Do not dispatch an agent when its shell tool or session capture fails; report the setup failure.
7. Take an initial Sprite checkpoint and record its ID. Take further checkpoints before substantial dependency changes, migrations, or other risky experiments.

The factory should use clean, controlled Codex configuration inside the Sprite. If it accepts an existing repository, inspect that repository's project configuration before using an automated trust path; a repository may contain hooks unrelated to Entire.

## Codex runner contract

The Codex runner should expose `prepare`, `checkReady`, `startTask`, `resumeTask`, `streamEvents`, `cancelTask`, and `getSessionId` operations. It translates task records into Codex CLI calls and returns normalized progress, completion, and failure events. The controller stores both its own task ID and the Codex session ID.

The runner declares capabilities such as session resume, structured event streaming, unattended execution, and Entire integration. The scheduler chooses tasks and dependencies, not a different harness. The reviewer reads Entire history using the recorded Codex session IDs.

## Build workflow

1. **Intake:** Save the user's request, target repository or reference material, constraints, and expected deliverables as a run record. Keep the request available to every later stage.
2. **Research:** Inspect the repository and current documentation for the technologies involved. Record sources, versions, findings, and unresolved questions in the project. Research can run in parallel when topics are independent.
3. **Plan:** The orchestrator turns the request and research into acceptance criteria and a task graph. A planning agent writes `PLAN.md` in the target repository; the controller commits and pushes it before implementation. Changes in direction become explicit plan amendments and commits.
4. **Schedule:** Code identifies tasks whose prerequisites are complete. Jev may choose parallel or sequential execution among those tasks based on independence, overlapping files, and integration risk. If the tasks overlap or the decision is uncertain, schedule them sequentially.
5. **Build:** Builders work in the project Sprite one file at a time. The controller validates the changed file, commits and pushes it, and records the session and checkpoint before dispatching the next file. Independent builders use separate Git worktrees or branches and claim their files; the orchestrator integrates their commits. Run appropriate tests and record commands, results, and commit IDs against task IDs.
6. **Review:** A reviewer compares the original request, committed plan and amendments, Entire session history, code diff, and test evidence. It reports mismatches or defects to builders and verifies the fixes. Review completion requires evidence for each acceptance criterion.
7. **Deliver:** Produce the requested artifact. For a web app, start a Sprite service for a preview; for other software, return the relevant executable, repository, package, or files. Deployment to an external platform is a separate, recorded step when the request calls for it.
8. **Teach:** Generate a tutorial from the verified result and the recorded sessions: how the result works, how to run it, the key decisions, and what to change next. Commit the tutorial to the project repository.

Persist run and task state outside the Sprite as each stage completes. A cold Sprite wake loses process memory, so the controller must be able to resume from committed files, Entire records, and its own database. Use a Sprite service for processes that must restart on wake. Use the Sprites Tasks API when an active background run must finish before the Sprite sleeps.

## First validation: rebuild Girl Dinner

Use `/Users/rizelscarlett/Documents/work/girl-dinner` and its GitHub repository as **reference material**. The factory should create a separate target repository and Sprite for the rebuild, leaving the original project unchanged. The request given to the factory should describe the product in ordinary language; the agents may inspect the reference to understand requirements and compare results, but the factory code must contain no Girl Dinner-specific steps.

Girl Dinner exercises several important capabilities:

- Next.js/React application setup and a mobile web experience.
- Google Places for restaurant discovery and TypeSafe Jev for preference scoring, with local sample data when live services are unavailable.
- Supabase migrations, persistent group rooms, and realtime updates across phones.
- Server-only credentials and external deployment on Vercel when deployment is part of the run and the required access is available.
- A committed plan, Entire-linked implementation sessions, review against the plan, and a tutorial grounded in the actual build history.

The factory should discover these needs from the request, reference repository, and documentation. It must not assume that every future project uses these providers or even produces a web app. Verify the rebuilt app with real build and interaction checks; when external credentials or services are unavailable, distinguish the working local/fixture path from unverified live integrations.

## First implementation milestones

1. Controller creates a Sprite, runs one command, reconnects after idle, and records the Sprite ID.
2. Bootstrap creates a private target repository and Sprite or clones an explicitly supplied target, enables Entire for Codex, installs agent rules for factory-created repositories, verifies hook handling, authenticates Codex, runs a shell command, and captures its session. A one-file Codex edit is committed and pushed with its checkpoint.
3. Orchestrator produces and commits a research-backed `PLAN.md` with acceptance criteria and task dependencies.
4. Builder completes one task; reviewer uses the diff, plan, and Entire session to evaluate it; a fix can return through the same loop.
5. Add bounded Jev scheduling and two independent worktrees, then integrate their commits.
6. Add artifact preview or delivery and a tutorial based on the completed run.
7. Run the Girl Dinner rebuild as an end-to-end validation, then test a materially different request to prove the workflow is general.

## Autonomous execution milestone

The local CLI becomes a thin submit/status client. A dedicated orchestrator Sprite
runs the controller as a supervised service with a durable SQLite queue. It owns
the Sprites API token and GitHub repository-creation credential; project Sprites
receive only their own repository deploy keys and Codex authentication. A request
continues after the submitter disconnects. On service restart, unfinished jobs
are reconciled against the controller database, Git commits, and Entire sessions
before dispatching more work. Active long jobs use renewable Sprite tasks to
prevent idle sleep. One job per project may run at a time.

Every blocking acceptance criterion in a generated plan must cite an exact part
of the user's request or supplied reference. An independent scope review checks
that the cited source supports the criterion. Extra product ideas belong in a
nonblocking follow-up section; they cannot become required tests or block
delivery. The reviewer evaluates the approved contract, implementation, and
executed evidence rather than treating every planner suggestion as a mandate.

The controller classifies failures as repairable, transient, or externally
blocked. It retries bounded transient failures, sends actionable defects back
to Codex in the project Sprite, and pauses on missing credentials or exhausted
API quota without burning repeated calls. Status exposes the exact stage,
worker session, committed artifact, verification result, and next action.

Autonomy is proven with two unrelated requests and a restart during an active
run. A completed job must include a clean pushed repository, Entire-linked
implementation history, passing required checks, review approval, tutorial,
and the promised artifact or preview. An external blocker is reported as such,
never as a completed build.

## References

- [Fly.io Sprites overview](https://docs.fly.io/sprites/)
- [Sprites API and SDK examples](https://sprites.dev/api)
- [Sprites MCP server](https://docs.fly.io/sprites/integrations/remote-mcp/)
- [Sprite lifecycle and persistence](https://docs.fly.io/sprites/concepts/lifecycle/)
- [Sprite services](https://docs.fly.io/sprites/concepts/services/)
- [Codex hook configuration and trust](https://learn.chatgpt.com/docs/hooks)
- [Entire CLI setup and agent hooks](https://github.com/entireio/cli#agent-hook-configuration)
