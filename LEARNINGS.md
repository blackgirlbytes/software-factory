# Learnings from building Glasstown and Airkeys

Working notes from the factory setup and first product build, September 29, 2026.
These capture the questions, decisions, surprises, and practical lessons from our
conversation. They are a retrospective of this implementation, not a claim that
every future project will work without intervention.

## 1. The factory and its products are separate things

The starting idea was to run something like
[Goosetown](https://github.com/aaif-goose/goosetown) inside a Sprite, using Codex
instead of Goose. That became **Glasstown**: a small adaptation of its planning,
building, reviewing, and Town Wall ideas, with captured sessions as a central
feature. The name reflects being able to look into how the work happened.

The factory repository coordinates work. Each new product gets a separate folder
inside the Sprite and a separate private GitHub repository. Airkeys, the music
app, is one product made through the factory; its application code does not
belong in the factory repository.

Existing `codextown` filenames, commands, and service names remain for
compatibility. Renaming the product did not require renaming every internal path.

| Piece | Its job in our setup |
| --- | --- |
| This Codex chat | Discuss the idea, settle constraints, and coordinate delivery |
| `AGENTS.md` and the Glasstown skill | Make the workflow defaults discoverable in a new chat |
| Factory runner | Execute bounded roles, check their output, and prepare a preview |
| Sprite | Hold the remote project files, tools, and running servers |
| Codex inside the Sprite | Plan, change code, write documentation, and review |
| GitHub | Store pushed code and project history |
| Entire | Capture sessions and connect their context to commits |
| Chrome on the Mac | Run the app's browser code and display the result |

## 2. A Sprite is persistent, but a folder is not a separate machine

Reusing the configured Sprite does not mean replacing its previous project.
Projects live in separate directories under `/home/sprite/projects/` and keep
their own Git repositories. Follow-up work uses the named project's existing
folder and repo.

Those folders still share the Sprite's CPU, memory, disk, installed tools, and
available authentication. This is convenient organization, not isolation between
machines. A new Sprite is possible, but it needs its own setup and working logins.
The factory does not yet provision and authenticate fresh Sprites automatically.

Setting the connector's maximum to three Sprites established a capacity limit;
it did not mean every task needed three machines. This implementation used one.
We did not measure a dollar cost from that setting.

Persistent storage and running processes are also different. Project files can
survive a restart while an app server or local tunnel needs reopening. Deleting
the Sprite would lose its local files; pushed Git history and synced checkpoints
are what remain elsewhere. Uncommitted work and ignored runtime data need their
own preservation strategy.

## 3. “It runs in the Sprite, but I see localhost” means a tunnel

The preview path is:

```text
Chrome on the Mac
    → a local localhost port
    → an authenticated Sprite connection
    → the app server inside the Sprite
```

The local URL is an entrance to the remote server. It does not mean the whole
project has been copied to the Mac. The client chooses an available local port,
so the preview does not have to displace an existing app on `localhost:3000`.

There is an important browser detail: Chrome downloads the frontend JavaScript
and runs it on the Mac. For Airkeys, camera access, hand tracking, and Web Audio
happen in that browser. Hosting the files in a Sprite does not make the Sprite
use the Mac's webcam remotely.

The tunnel must remain alive while using the preview. Closing it does not delete
the project. Reopening a saved run can restart its preview without asking the
models to rebuild the app. A localhost preview is not a public deployment, and
its URL is not a shareable address for someone else's computer.

## 4. Authentication belongs to a particular environment

We encountered several separate logins:

- The Mac needs access to the Sprite.
- Codex running inside the Sprite needs an OpenAI account session.
- Git inside the Sprite needs permission to push to GitHub.

Being signed in on the Mac does not automatically authenticate a command inside
the remote environment. With multiple accounts, the account selected during the
browser approval matters. Device codes can expire; generating a fresh code and
opening its approval page in external Chrome was part of the setup.

A browser saying “Signed in to Codex” is useful evidence, but the meaningful
check is whether the intended remote Codex installation reports a working login
and can run a task. Credentials should remain in their intended credential
stores, never in project files, commit messages, or dashboard output.

We also learned that an executable being present does not guarantee it is the
right runtime. The Sprite's preinstalled Codex lacked a required helper. The
complete official package and a launcher compatible with the Sprite environment
were needed; the launcher preserved the role-specific sandbox settings.

## 5. Planning back and forth happens before the unattended run

The user should be able to discuss an idea, change constraints, and narrow the
MVP before paying for implementation. That conversation happens here.

The factory's planner serves a different purpose: it converts an accepted task
into implementation steps and acceptance checks. It does not pause to interview
the user. Sending a vague prompt directly to the runner skips the interactive
planning stage.

The agreed scope belongs in `PROJECT_BRIEF.md` in the product repository. Remote
workers do not automatically inherit the whole planning conversation. A written
brief transfers the requirements, exclusions, and definition of done into their
actual working context.

For follow-up work, name the existing project and describe the change. It should
not create another repository just because the conversation is new.

## 6. Repeated preferences belong in the factory

The user should not have to append this list to every product idea:

- Use a separate project folder and private GitHub repo.
- Discuss the plan before building.
- Use the configured low-reasoning model.
- Enable Entire and commit/push each file change.
- Open the finished web preview in Chrome.
- Return the GitHub and Entire links.
- Write and review a project tutorial, and return its link.

`AGENTS.md` routes product requests to the repository's
[Glasstown skill](.agents/skills/glasstown/SKILL.md). The skill supplies the
workflow, while the runner implements checks and execution steps.

That distinction matters: instructions guide an agent; they are not the same as
hard enforcement in program code. The direct CLI still expects a prepared
repository. It does not itself conduct the planning conversation, create a
GitHub repository, or provision a Sprite.

A simple prompt in a new chat **in this factory repository** can therefore be:

> I want to build a music app that lets a beginner make music with hand gestures.
> Help me narrow it to a small first version.

The idea and product constraints should change between projects. The plumbing
should not need to be repeated.

## 7. Entire captures context; Git commits still need a workflow

Entire recording sessions is different from an agent committing every change.
Git stores the code history. Entire connects recorded session context to that
history. Our instructions require this sequence:

```text
change one file → commit that file → push → change the next file
```

The factory's preparation helper enables tracking before product workers run.
It uses Entire-generated configuration and hooks, preserves existing project
instructions, and commits setup files separately. Calling `entire enable -y`
ad hoc would not by itself cover all those factory requirements.

Configuration alone was not sufficient. Hook approval needed to be persisted in
the dedicated Codex profile. An early smoke run made a commit without the
required checkpoint trailer, and the delivery check rejected it. A later check
verified the commit trailer, the pushed checkpoint ref, and stored transcript.

The useful lesson is to verify the whole recording path, not just the existence
of `.entire` or a settings flag. Preserve hooks and transcripts, and confirm that
history actually reached the remote.

There is also an enforcement limit: checking one file per commit, a clean tree,
pushed commits, and checkpoint trailers does **not** prove that an agent committed
file A before editing file B. Some build steps exposed that gap. If exact edit
ordering must be guaranteed, it needs stronger enforcement than a final Git audit.

## 8. A visible workflow is not yet agent-to-agent conversation

Glasstown's Town Wall shows phases, roles, and results. It does not implement
Goosetown's full communication system, parallel flocks, or shared agent chat.
The roles exchange saved outputs in a sequential workflow.

The current workflow is:

```text
accepted brief → planner → builder → tutorial writer → reviewer → preview
```

The first Airkeys build ran before the tutorial stage was added. The current
factory adds a bounded tutorial-writing call and reviews `tutorial.md` with the
code. Updating the workflow does not retroactively put a tutorial into an older
completed run, and the Sprite factory checkout must be updated while idle to
pick up new behavior.

The preview worker is ordinary code, not another model call. It starts a server
and checks readiness; the Mac client opens Chrome through the operating system.
There is no need for computer-use automation just to open a URL.

A rejected review stops the run. There is no automatic, indefinite repair loop.
A subsequent repair is another explicit, bounded task.

## 9. Low reasoning is a constraint, not a promise of one-shot delivery

Factory model roles use `gpt-5.6-luna` with low reasoning. The current runner fixes
those choices instead of silently inheriting a more expensive profile or
upgrading after a failure. This describes the factory workers, not necessarily
the model hosting the coordinating chat.

Airkeys took several bounded passes: an initial timeout, repair work, review
findings, browser findings, and a focused final correction. Keeping the same
model did not remove the need for supervision.

Timeouts limit duration, not dollar spend. Adding a tutorial writer adds another
model call. We did not produce a measured total cost for the build, so “cheap
model” should not be presented as a measured cheap end-to-end outcome. Useful
future measurements include calls, elapsed time, usage, and repair count.

## 10. The broad music idea needed a very specific MVP

The original idea combined air instruments, real instruments, automatic musical
assistance, and learning. We narrowed the first version to a piano-like browser
experience:

- Point into a labeled note zone and pinch to play; release before another note.
- Use onscreen keys or computer keys as a camera-free fallback.
- Show notes and chords, with C, Am, F, and G assistance and a short exercise.
- Add a simple rhythm and basic audio controls.
- Offer an adjustable visual guide over a real keyboard.

MediaPipe provides hand landmarks. It does not know which musical note someone
intends, whether a physical piano key was depressed, or whether a performance is
correct. Those behaviors require application logic or additional sensing.

Airkeys' real-keyboard mode is a visual guide. It does not listen to the
instrument or grade actual key presses. The MVP omitted microphone analysis,
MIDI, recording, accounts, and multiple instrument types.

Showing the notes and chord tones makes assisted playing educational: the app
can reveal what it adds rather than hiding all musical structure from the user.
That still does not establish that the app teaches playing proficiency; that
would need real use and feedback.

## 11. Real-time input needs deliberate state management

Several details matter more than “connect MediaPipe to a synthesizer” suggests:

- Mirror coordinates consistently so the visible keyboard matches hit testing.
- Make the playable region match the zones drawn on screen.
- Normalize pinch distance by hand size so distance from the camera matters less.
- Use separate pinch/release thresholds and avoid retriggering every frame.
- Reset stale state when tracking disappears and keep hand identities consistent.
- Bound inference frequency so camera work does not overwhelm the UI.
- Handle permission denial, late camera startup, and Stop during asynchronous work.

Camera access and audio activation also need a clear user action. Manual controls
let the app remain useful when camera access fails.

Audio needs lifecycle discipline too. Finished voices must leave the active set;
otherwise a voice limit can become a freeze. Stop should really stop the intended
camera, notes, and rhythm. Changing tempo should not unexpectedly start a stopped
beat, and muted playback should not count as completing a learning exercise.

## 12. Review approval, passing tests, and working behavior are different evidence

These were concrete findings from the first build:

| What happened | What it taught us |
| --- | --- |
| The first worker hit its time limit | Inspect saved work and failure state before deciding on a bounded continuation |
| A proposed MediaPipe version did not exist on the CDN | Verify real asset URLs and match JavaScript and WASM versions |
| Finished audio voices were not removed correctly | Test repeated interaction; one successful note misses resource-lifecycle bugs |
| A gesture test used values inconsistent with its normalized threshold | Check the fixture's math before changing working logic to satisfy it |
| Guide markers were drawn into a hidden view | Browser checks need to cover modes, not just the presence of a canvas |
| Muted chords advanced the exercise | Test meaning and state transitions, not just whether a button responds |
| A broad selector highlighted guide labels instead of piano keys | Inspect visible feedback against the actual DOM and user flow |
| A patch expected an older version of the file | A failed precondition can safely prevent a wrong edit; update the patch against current code |

A successful HTTP response proves that the preview server responds. It does not
prove that controls, camera permissions, or audio work. A reviewer can approve
code and still miss a browser behavior. Tests should exercise the user journey
and the failure cases that matter.

For the delivered Airkeys version, verification included eight Node tests,
browser checks for music controls and repeated notes, actual MediaPipe startup
with a synthetic camera, simulated hand landmarks, permission-denial fallback,
Stop behavior, and a narrow-screen layout check.

The boundary matters: synthetic input and simulated landmarks did not establish
how real hands, lighting, camera angles, latency, or sound quality would feel.
The user's real webcam was not used for those checks. The handoff explicitly
left actual tracking feel and sound quality for a hands-on try.

## 13. Delivery should include the product, its evidence, and an explanation

A useful factory result includes:

1. An accessible preview, with the local tunnel kept alive.
2. The project repository and exact code commit.
3. An Entire link to the captured work.
4. A reviewed `tutorial.md` link under the current workflow.
5. A clear account of what was tested and what remains unverified.

Commit links are more precise than a moving branch when discussing a particular
result. Private GitHub and Entire pages may require access. A preview serves the
project's current files, so reopening an old run after later edits is not the
same as opening an immutable historical deployment.

The tutorial's purpose is to explain the actual implementation: setup, usage,
key files, data flow, important code, limitations, and a small extension exercise.
It should help the user understand and change the product, and should distinguish
verified behavior from assumptions. Its writer is constrained to the tutorial
file, and the reviewer checks documentation alongside the implementation.

## 14. What remains a next step, rather than a completed feature

The prototype still leaves room for fresh-Sprite provisioning, richer agent
communication, stronger enforcement of edit/commit ordering, usage reporting,
and more automatic interaction checks before preview approval. Old previews
also need deliberate retirement so services do not accumulate indefinitely.

For Airkeys, real-user testing comes before adding more instruments or claiming
reliable physical-instrument recognition. The most useful next evidence is
whether someone can position a hand, discover the pinch interaction, make a
short musical phrase, and understand the notes they played.

## 15. Terminal cookbook: operate this yourself

You can operate the factory without this coordinating chat. **Glasstown still
runs Codex agents internally.** If you mean no AI calls at all, use the manual
server example below instead. The Sprites CLI works without an MCP client.

Commands below target our configured environment. Run one step at a time and
stop if it fails; do not paste the whole chapter as one script. Blocks are
labeled **Mac** or **Sprite** because the two machines have different files,
processes, and logins. Replace example project names and task text as needed.

### A. Connect to the existing Sprite

**Mac — Terminal:** make the installed CLI available in this terminal, list the
Sprites, and run a remote command:

```sh
export PATH="$HOME/.local/bin:$PATH"
sprite list
sprite exec -s mcp-rizel-codextown --no-port-forward --no-stdin -- pwd
```

If access is not already configured, sign in, then try the listing again:

```sh
sprite login -o rizel-scarlett-105
```

There is no separate boot command needed for this workflow: connecting or
executing a command wakes the Sprite. For an interactive Linux terminal:

```sh
sprite console -s mcp-rizel-codextown --no-port-forward
```

You are now **inside the Sprite**. Use `exit` to return to the Mac. We disable
automatic port forwarding here so later proxy commands own their ports explicitly.

### B. Check the setup and update the factory when idle

**Sprite:** check the runner's status first. If a build is running, wait for it
to finish before updating its code.

```sh
cd /home/sprite/software-factory
python3 codextown.py status
git status --short
```

If the factory is idle and Git reports no local changes:

```sh
git pull --ff-only
```

Check remote tool authentication and Git identity:

```sh
/home/sprite/software-factory/codex-sprite.sh login status
gh auth status
git config user.name
git config user.email
entire version
```

The existing Sprite is configured. Only repair a login if its check fails.
For Codex, run this **inside the Sprite**:

```sh
/home/sprite/software-factory/codex-sprite.sh login --device-auth
```

Use the URL and fresh code it prints. On the **Mac**, open that URL in Chrome:

```sh
open -a 'Google Chrome' 'PASTE_THE_LOGIN_URL_HERE'
```

For a missing GitHub login, run **inside the Sprite**:

```sh
gh auth login
gh auth setup-git
```

If Git identity is missing, set it inside the Sprite with your own name and email:

```sh
git config --global user.name 'YOUR_NAME'
git config --global user.email 'YOUR_COMMIT_EMAIL'
```

### C. Start a new product repository

Skip this section for follow-up work on Airkeys or another existing project.
Choose an unused name both inside the Sprite and on your GitHub account. The
example below creates a real private GitHub repository when you run it.

**Sprite:** set the new name and inspect whether it already exists:

```sh
project_slug=gesture-jam
project_dir="/home/sprite/projects/$project_slug"
gh repo view "$project_slug"
ls -ld "$project_dir"
```

Proceed only after establishing that the name is unused. A network or login
error from GitHub is not evidence that a repository does not exist. If a project
already exists, use it intentionally or choose a different name.

**Sprite:** create the directory, initialize Git, create its private remote, and
prepare tracking. The `&&` operators stop this sequence on a failed step:

```sh
mkdir -p /home/sprite/projects &&
mkdir "$project_dir" &&
git init -b main "$project_dir" &&
gh repo create "$project_slug" --private --source "$project_dir" --remote origin &&
python3 /home/sprite/software-factory/codextown.py prepare --repo "$project_dir"
```

`prepare` configures Entire and project instructions and commits/pushes setup
files. It does not make a model call. If a step fails, inspect the partially
created project before trying again; do not delete it or blindly recreate it.

### D. Write your brief before starting the workers

When operating without this chat, you provide the scope and constraints yourself.
Edit the example text below before running it. Keep secrets out of the brief.

**Sprite — in the same terminal as the project variables above:**

```sh
cd "$project_dir" &&
cat > PROJECT_BRIEF.md <<'BRIEF'
# Gesture Jam — first version

Build a small browser music toy for a beginner.

Scope:
- One octave of labeled piano keys with mouse and keyboard controls.
- Optional MediaPipe hand tracking: point at a note zone and pinch to play.
- Release before another note; show the active note.
- A C–Am–F–G chord exercise that explains which notes form each chord.

Constraints:
- Process camera frames in the browser; no video upload or microphone capture.
- Ask for camera access only after the user starts it.
- No accounts, payments, recording, MIDI, or multiple instruments in this MVP.
- Keep manual controls usable if camera access is denied.

Acceptance:
- Repeated notes stay responsive.
- Held pinches do not retrigger continuously.
- Stop releases camera and audio activity.
- Labels remain usable on a narrow screen.
- Document setup, behavior, limitations, and checks in tutorial.md.
- Report separately what needs testing with a real hand and webcam.
BRIEF
```

Immediately commit and push that one file before editing another:

```sh
git add -- PROJECT_BRIEF.md &&
git commit -m "Document the initial project brief" &&
git push
```

This manual commit records your brief in Git. Entire captures supported agent
sessions; a shell command or hand-written file does not itself create an AI
conversation transcript.

### E. Run Glasstown and get the browser preview

Return to the **Mac** with `exit`, or open a new Mac terminal. Update the local
factory checkout only if it has no local changes:

```sh
cd /Users/rizelscarlett/Documents/work/software-factory
git status --short
```

When clean:

```sh
git pull --ff-only
```

**Mac — start the new project's build:**

```sh
python3 codextown_client.py \
  --sprite mcp-rizel-codextown \
  --repo /home/sprite/projects/gesture-jam \
  'Implement PROJECT_BRIEF.md. Run the acceptance checks and report any unverified behavior.'
```

The project path is on the Sprite, even though you run the client on the Mac.
The runner uses the configured low-reasoning roles, tracking, tutorial stage,
review, and preview. The client prints result links and opens Chrome after a
successful review and ready preview. Keep this terminal open for the tunnel.
Save the printed run ID.

**Mac — an example follow-up on existing Airkeys:** this starts a new model run
and changes the existing app, so run it only when you want that change.

```sh
python3 codextown_client.py \
  --repo /home/sprite/projects/airkeys \
  'Add a clearly labeled master volume slider. Preserve camera gestures, chord exercises, and existing controls. Update tests and tutorial.md.'
```

The default timeout is 300 seconds per role. For a deliberately longer bounded
run, add `--timeout 600`; this changes the time allowance, not the model or
reasoning setting. A failed or rejected run needs inspection and a specific
follow-up task. There is no automatic repair conversation in this command.

### F. Reopen a preview without running any models

**Mac — from the factory directory:** substitute the actual saved run ID:

```sh
python3 codextown_client.py --open-run RUN_ID
```

To find recent IDs and statuses from the **Mac**:

```sh
sprite exec -s mcp-rizel-codextown --no-port-forward --no-stdin -- \
  python3 /home/sprite/software-factory/codextown.py status
```

Reopening supports the 30 most recent saved runs. It may choose a different local
port, so use the URL it prints. `Ctrl+C` closes that local connection; it does not
remove the project or its preview service.

### G. Open the Town Wall or forward a port yourself

**Mac — terminal one:** connect to the existing dashboard service:

```sh
sprite proxy -s mcp-rizel-codextown 18080:8080
```

**Mac — terminal two:** open the local end in Chrome:

```sh
open -a 'Google Chrome' http://localhost:18080/
```

Here `18080:8080` means **local port 18080 → Sprite port 8080**. If the local port
is occupied, choose another unused local port and change the URL accordingly.
A proxy only forwards traffic: it does not create a server on the remote port.

For an app already listening on Sprite port 3002, the equivalent is:

```sh
sprite proxy -s mcp-rizel-codextown 13002:3002
```

Then open `http://localhost:13002/` in a separate Mac terminal or Chrome. Use the
actual remote port from the run's status; 3002 is only an example.

### H. Inspect code and recorded sessions

**Sprite — choose the project you want to inspect:**

```sh
cd /home/sprite/projects/airkeys
git status --short
git log -5 --format=full
entire status
entire checkpoint list --json --no-pager
entire checkpoint explain --commit HEAD --no-pager
```

The last command needs a commit with captured checkpoint history. Local CLI help
is the best syntax reference for the installed version:

```sh
entire checkpoint explain --help
```

For a failed factory run, look at its metadata and review artifacts under
`~/.local/state/codextown/runs/RUN_ID/` inside the Sprite. These are operational
files, not files to copy into the public factory repo. Inspect the reported
failure before deciding what to fix or whether to increase a timeout.

### I. Run a web page with no AI calls at all

For a small manual static-site experiment, create a separate scratch directory.
This example makes no GitHub repository and invokes neither Glasstown nor Codex.
It therefore does not provide factory tracking, review, or tutorial generation.

**Sprite:** choose an unused scratch directory and create a page:

```sh
mkdir /home/sprite/manual-web-demo &&
cd /home/sprite/manual-web-demo &&
printf '%s\n' '<!doctype html><title>My Sprite app</title><h1>Hello from my Sprite</h1>' > index.html
```

**Sprite — keep this server terminal open:**

```sh
python3 -m http.server 3100 --bind 0.0.0.0 --directory /home/sprite/manual-web-demo
```

**Mac — another terminal, keep the proxy open:**

```sh
sprite proxy -s mcp-rizel-codextown 13100:3100
```

**Mac — another terminal:**

```sh
open -a 'Google Chrome' http://localhost:13100/
```

Edit the page yourself and refresh Chrome. This basic Python server serves files
in the chosen directory, so use a dedicated directory of browser-safe files,
not a repository root containing Git metadata or credentials. `Ctrl+C` in the
server terminal stops the server; `Ctrl+C` in the proxy terminal stops forwarding.

### J. Create another Sprite when you actually need one

**Mac — optional, creates another remote environment:**

```sh
sprite create -o rizel-scarlett-105 my-new-sprite
sprite console -o rizel-scarlett-105 -s my-new-sprite --no-port-forward
```

Choose an unused name and stay within your configured capacity. The manual
static-site example can be used there by changing `--sprite`/`-s` in its Mac
commands. Creating the Sprite alone does **not** install this factory or transfer
its authenticated sessions.

For a new Glasstown environment, you still need the factory checkout at
`/home/sprite/software-factory`, its configured Codex runtime, Entire, Git author
identity, and working Codex/GitHub logins. Follow the setup sections in the
[factory README](README.md) and the
[Entire installation guide](https://docs.entire.io/installation), then perform
the preflight checks above. Once configured, pass `--sprite my-new-sprite` to the
Mac client. The cookbook's default path uses the already-configured Sprite.

Command syntax here was checked against the installed Sprites CLI, remote Entire
and GitHub CLI help, and the factory's client/runner arguments. For additional
Sprite operations, see [Working with Sprites](https://docs.sprites.dev/working-with-sprites/).
These examples were documented without launching another product build or
creating another Sprite.

## Reference points

- [Factory README](README.md), [agent instructions](AGENTS.md), and
  [Glasstown workflow skill](.agents/skills/glasstown/SKILL.md).
- [Upstream Goosetown](https://github.com/aaif-goose/goosetown), which inspired the workflow.
- [Airkeys repository](https://github.com/blackgirlbytes/airkeys) — private.
- [Delivered Airkeys commit](https://github.com/blackgirlbytes/airkeys/commit/72787597eb51dd3fdebae6778aa7713e7eb0472f).
- [Airkeys captured session history](https://entire.io/gh/blackgirlbytes/airkeys/commit/72787597eb51dd3fdebae6778aa7713e7eb0472f).
- [Successful tracking smoke-test commit](https://github.com/blackgirlbytes/software-factory/commit/c7173d304de977c752fc6200ddcfdc97d83a9d88).

These notes draw on the conversation, recorded build results, and current factory
documentation. Entire checkpoint `01M3PAD7PY4NGX9N9AH8AZ6VS6` was consulted while
writing; its recorded session includes the Airkeys repair updates, browser
verification findings, and final handoff. Current tutorial-stage behavior was
cross-checked against the factory README and skill. No new model-generated
Entire summary was needed to recover that context.
