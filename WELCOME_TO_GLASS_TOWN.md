# Welcome to Glass Town

Steve Yegge describes Gas Town’s workers as “superintelligent robot chimps” and compares the setup to a factory with “machines that can disembowel you if you’re not careful.” [Encouraging stuff](https://yegge.ai/essays/welcome-to-gas-town/).

Everyone seems to be building a software factory. Obviously, I needed one too.

I’d already played with [Goosetown](https://github.com/aaif-goose/goosetown), which coordinates agents to research, build, and review work. I wanted to make a smaller version with Codex, session tracking, and enough visibility to understand what happened after I handed over a task.

In [Welcome to Gas City](https://steve-yegge.medium.com/welcome-to-gas-city-57f564bb3607), Yegge defines the concept:

> A dark factory is any system in which coding agents are set up to work autonomously without humans watching.

He also makes clear that unattended work can still be observable. The darkness is about who’s on the factory floor, not whether anyone can inspect it.

I wanted that inspection to be part of the output. Give me the app, the code, the conversations behind the changes, and an explanation I can learn from.

Hence, Glasstown.

There was a practical motive underneath the naming exercise. I work in developer relations. A working demo is useful, but I also need to understand it well enough to explain it, change it during a workshop, and answer questions about the parts that break. A factory that produces both a project and its development history could make that work easier.

## First, give the factory a computer

For an extra challenge, mine would run in a [Sprite](https://fly.io/blog/code-and-let-live/): a remote Linux computer from Fly.io with persistent storage. I could install tools, build projects, and return later to the same files and dependencies.

That persistence mattered. Each new idea gets its own project folder and private GitHub repository. The factory lives separately. Building a music app should not overwrite yesterday’s experiment or require reinstalling every tool.

The current setup shares one Sprite across projects. Separate folders keep them organized, but they share resources and available credentials. I haven’t built automatic provisioning for a fresh Sprite per project.

Getting Codex running there involved more setup than signing into the desktop app. My Mac needed access to the Sprite. Codex inside the Sprite needed its own login. Git needed GitHub access. Successfully approving a browser login was only one step; the remote process had to actually receive and use it.

Then I reached the question I apparently needed to ask out loud: if the app lives over there, how am I looking at it on localhost?

A tunnel.

For example, if an app is listening on port 3002 inside the Sprite, this runs on my Mac:

```sh
sprite proxy -s mcp-rizel-codextown 13002:3002
```

Chrome can now reach it at `http://localhost:13002`. Requests entering local port 13002 travel to remote port 3002. The server stays in the Sprite. The browser downloads the frontend and executes its JavaScript locally.

That last distinction becomes important when the frontend wants my webcam.

## Give everyone a job

Glasstown’s current workflow has five roles, executed in order:

| Worker | Job |
| --- | --- |
| Planner | Turn the accepted brief into implementation steps and acceptance checks. |
| Builder | Write code, run tests, and commit and push changes. |
| Tutorial writer | Explain the actual implementation in `tutorial.md`. |
| Reviewer | Check the code and tutorial, then approve or reject the result. |
| Preview worker | Start the approved app and check that its server responds. |

The first four invoke Codex using `gpt-5.6-luna` with low reasoning. I wanted to keep model usage under control. The preview worker is ordinary code; starting a server does not need another model opinion.

A rejected review stops the run. There’s no automatic escalation to a more expensive model or endless repair loop. Another attempt is a deliberate follow-up task.

Before any of that, I discuss the product and constraints in the coordinating chat. Once the plan is settled, it goes into `PROJECT_BRIEF.md`. The remote planner doesn’t inherit our entire conversation or stop to interview me. It needs the decisions written down.

The repository’s `AGENTS.md` points product requests to a Glasstown skill. That skill supplies defaults: separate project, private repo, tracking, low reasoning, tutorial, browser preview, and result links. I wanted to spend the next conversation discussing the next app, rather than remembering which infrastructure instructions I forgot.

## Put windows in it

The Town Wall shows which phase is running and what happened. It’s a progress view. Unlike Goosetown’s coordination system, my workers don’t currently broadcast messages to one another. They hand over files and results sequentially.

For the history behind those results, I added Entire. It captures Codex sessions and links them to Git commits. Git tells me what changed; the recorded conversation helps explain how we got there.

The project instructions require one file change, followed by a commit and push, before the next file. Entire doesn’t automatically make the agent obey that sequence. The runner checks for a clean tree, pushed commits, one file per commit, and checkpoint trailers. Those checks still cannot prove the exact order in which files were edited.

Even tracking needed verification. An early test produced a commit without its checkpoint trailer because the Codex hooks weren’t properly approved. The factory rejected the delivery. After fixing the configuration, we checked that the checkpoint and transcript actually reached the remote.

A settings file saying tracking is enabled is a poor substitute for finding the recorded session.

## But does the factory work?

I asked it to build a music app for someone who doesn’t know how to play an instrument. Ideally, I could move my fingers in the air, hear something musical, and see which notes or chords I was playing.

We narrowed that into Airkeys: one octave of piano-like notes, MediaPipe hand tracking, chord assistance, a backing rhythm, and a short C–Am–F–G exercise. Mouse and keyboard controls provide a fallback. An adjustable overlay can guide someone looking at a real keyboard.

The gesture is simple: point into a labeled note zone, pinch your thumb and index finger, then release before playing again.

MediaPipe supplies hand landmarks. Airkeys maps those coordinates and gestures to notes. It doesn’t magically recognize musical intent, and the real-keyboard guide doesn’t detect physical key presses or listen to the instrument.

Camera processing and synthesized audio run in Chrome on my computer. The Sprite serves the app’s files.

The first build did not emerge ready for a concert.

One proposed MediaPipe version didn’t exist on the CDN. Audio voices weren’t being removed correctly after finishing, which could freeze the app after repeated notes. The reviewer caught guide markers being drawn into a hidden view and muted chords advancing the exercise.

After repairs, review approved the app. Browser checks then found that note highlights were landing on the guide labels instead of the playable keyboard. Both elements matched the same broad selector.

These were different failures requiring different evidence. Loading a page wouldn’t expose the audio problem. A successful note wouldn’t prove repeated playing worked. Review approval didn’t establish that the right keys lit up.

The final version passed unit tests and browser checks, including MediaPipe startup with a synthetic camera, simulated pinch gestures, permission-denial fallback, and stopping camera activity. Real-hand responsiveness and sound quality still needed a hands-on try.

I added the tutorial writer after this initial build. For developer relations, getting an explanation alongside the implementation felt useful enough to make it a required stage for subsequent runs.

## Run it yourself

An agent can operate Sprites through MCP. I can also use the CLI directly, without a coordinating chat.

From the factory checkout on my Mac, this submits a task to an existing, prepared project:

```sh
python3 codextown_client.py \
  --repo /home/sprite/projects/airkeys \
  'Improve the camera onboarding. Preserve existing controls and update tutorial.md.'
```

Glasstown still invokes its Codex workers. The client waits for approval, connects a private tunnel, opens Chrome, and prints GitHub, Entire, and tutorial links. I keep that terminal open while using the preview.

To reopen a saved preview without new model calls:

```sh
python3 codextown_client.py --open-run RUN_ID
```

The [terminal cookbook](LEARNINGS.md#15-terminal-cookbook-operate-this-yourself) covers authentication, new-project setup, tracking, and manual port forwarding. The old `codextown` command names survived the rename.

## What I got out of it

I now have a reusable path from an agreed idea to a separate repository, an inspectable build history, and an app I can open. The tutorial stage gives future builds somewhere to explain their implementation instead of leaving that work in a closing chat message.

Airkeys also established the limits. Repairs needed supervision. Browser testing caught things review missed. Choosing a cheaper model didn’t eliminate retries, and I haven’t measured the total cost well enough to claim savings.

For my DevRel work, the next test is whether I can take one of these projects into a demo, use its tutorial, trace a decision through its sessions, and confidently change the code. Glasstown has given me the materials for that test. I still have to do it.
