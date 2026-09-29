# Welcome to Glass Town

Steve Yegge describes Gas Town’s workers as “superintelligent robot chimps” and compares the setup to a factory with “machines that can disembowel you if you’re not careful.” [Encouraging stuff](https://yegge.ai/essays/welcome-to-gas-town/).

Everyone seems to be building a software factory. Obviously, I needed one too.

I’d already played with [Goosetown](https://github.com/aaif-goose/goosetown), which coordinates agents to research, build, and review work. I wanted a smaller version using Codex, with the sessions captured so I could follow how an idea became code.

In [Welcome to Gas City](https://steve-yegge.medium.com/welcome-to-gas-city-57f564bb3607), Yegge defines a dark factory:

> A dark factory is any system in which coding agents are set up to work autonomously without humans watching.

He also points out that you can make that work observable. The agents can work unattended while leaving plenty for a human to inspect.

That was the part I wanted to build around. Give me the app, its code, and the conversations behind the changes. Then explain enough of it that I can do something with the result.

Hence, Glasstown.

I work in developer relations. A generated demo could save me time, provided I can explain it, extend it, and answer questions when someone tries something unexpected. I wanted a factory whose output would help me prepare for that work.

## Give it something to build

My test was a music app for someone who doesn’t know how to play an instrument. Me, for example. I wanted to move my fingers in the air, make something that sounded like music, and see the notes and chords as I played.

A modest request. Just teach my laptop to interpret a performance on an instrument that isn’t there.

We narrowed it to Airkeys: one octave of piano-like notes, MediaPipe hand tracking, chord assistance, a backing rhythm, and a C–Am–F–G exercise. Point into a labeled note zone, pinch your thumb and index finger, and release before playing again. Mouse and keyboard controls would work if the camera didn’t.

For a real keyboard, the MVP would provide an adjustable visual guide. Detecting actual key presses or listening to the instrument would have to wait.

Now the factory had a job with an observable result. A gesture should produce a note, and the right key should light up.

## A factory needs a computer

For an extra challenge, the factory would run in a [Sprite](https://fly.io/blog/code-and-let-live/), a remote Linux computer from Fly.io with persistent storage. Installed tools and project files could stay there between sessions. The same machine could serve the resulting app.

Airkeys got its own folder and private GitHub repository. The factory kept a separate checkout. Future projects would get their own folders too, so a new idea wouldn’t repurpose the previous app’s home.

They currently share one Sprite. That means shared resources and available credentials; separate folders aren’t isolated computers.

Authentication was less shared than I initially understood. My Mac needed Sprite access, Codex inside the Sprite needed an OpenAI login, and Git inside it needed GitHub access. Signing into the desktop app didn’t handle the other machine. Several browser codes later, the useful test was whether remote Codex could actually run.

## Airkeys enters the factory

First, the accepted scope went into `PROJECT_BRIEF.md`. The remote workers don’t inherit the planning conversation, so the brief carries the constraints and acceptance checks into their workspace.

The **planner** reads that brief and produces implementation steps. It doesn’t pause to ask whether I secretly wanted a guitar. That discussion needs to happen before starting the run.

The **builder** writes the app and runs tests. For Airkeys, that meant connecting MediaPipe’s hand coordinates to note zones and a Web Audio synthesizer. MediaPipe locates hands; the app still has to decide when a pinch counts as playing, when it ends, and whether another note is allowed.

I fixed the model roles to `gpt-5.6-luna` with low reasoning to keep usage under control. Each call has a time limit. A failure doesn’t silently buy a more expensive model or start an endless series of retries.

While this happens, the **Town Wall** shows the active phase and its status. My version is a sequential workflow: workers pass files and results along. It doesn’t implement Goosetown’s worker-to-worker messaging.

For the detail behind those status changes, I added Entire. It captures Codex sessions and connects them to Git commits. I can inspect a diff, then follow the recorded work that produced it.

That plumbing needed its own test. An early factory smoke run produced a commit without its Entire checkpoint trailer because the Codex hooks weren’t properly approved. The delivery check rejected it. We fixed the configuration and checked that the transcript actually reached the remote.

The instructions also require committing and pushing each file change before editing the next. The runner checks the final Git history for pushed, single-file commits and checkpoint trailers. That audit can catch missing history, though it cannot prove the order of every edit.

The **reviewer** then inspects the implementation against the task. If it rejects the result, the run stops. A repair gets a specific follow-up task.

Airkeys gave that policy some exercise.

## The reviewer approved it. The wrong keys lit up.

The initial builder hit its time limit. Inspecting the saved work uncovered a MediaPipe dependency version that didn’t exist on the CDN and an audio cleanup problem that could freeze the app after repeated notes.

After repairs, the reviewer found more: fingertip markers were drawn into a hidden view, and muted chords could advance the learning exercise. Those needed another pass.

Eventually, review approved the app. The **preview worker** started its server and checked for a successful HTTP response. This worker is ordinary code. It needs to start a process and check a URL, not consult a model.

The Mac client opened Chrome. Which brought me to a question: if Airkeys lives in the Sprite, why am I looking at localhost?

A tunnel connects a local port to the remote server. For an app listening on Sprite port 3002, I can run this on my Mac:

```sh
sprite proxy -s mcp-rizel-codextown 13002:3002
```

Then `http://localhost:13002` reaches that app. The client handles this automatically, choosing an available local port.

The server stays remote, but Chrome downloads and runs the frontend JavaScript locally. Airkeys therefore uses the webcam and generates audio on my computer. The Sprite doesn’t need a camera pointed at my hands.

With the browser available, further checks found that note highlights landed on the guide’s labels instead of the playable piano keys. A selector matched both sets of elements and picked the wrong ones.

Review had passed. The server responded. The wrong thing still lit up.

We fixed the selector and checked the final version again. Unit tests and browser checks passed, including repeated notes, the chord exercise, MediaPipe startup with a synthetic camera, simulated pinches, permission-denial fallback, and stopping camera activity.

That established specific behaviors. It didn’t tell me how real hands, awkward lighting, or my speakers would feel. Those still needed a hands-on try. The additional browser checks also required coordination outside the factory’s basic HTTP readiness check.

After this build, I added a **tutorial writer**. It reads the implementation and writes `tutorial.md`, covering setup, usage, important code, and limitations. The reviewer checks that explanation alongside the code before the preview opens.

The current sequence is planner, builder, tutorial writer, reviewer, preview. Airkeys helped reveal why the extra documentation stage belonged there.

## I can operate it myself

An agent can manage Sprites through MCP, but I can submit work from Terminal too. From the factory checkout on my Mac, this starts a run against the prepared Airkeys repository:

```sh
python3 codextown_client.py \
  --repo /home/sprite/projects/airkeys \
  'Improve camera onboarding. Preserve existing controls and update tutorial.md.'
```

Glasstown still runs Codex workers internally. The client waits for an approved, ready preview, connects the tunnel, opens Chrome, and prints the GitHub, Entire, and tutorial links. I keep the terminal open while using the preview.

To reopen one without another model run:

```sh
python3 codextown_client.py --open-run RUN_ID
```

The [terminal cookbook](LEARNINGS.md#15-terminal-cookbook-operate-this-yourself) covers creating a project, authentication, tracking, and manual tunnels. The `codextown` filenames predate Glasstown’s name.

For chat-driven builds, the repository’s instructions and skill supply the same defaults. I don’t have to request a private repo, tracking, low reasoning, and a preview every time. I can spend the planning conversation on the app.

## Was this worth building?

I got a working prototype, its recorded development history, and a workflow I can reuse. Subsequent builds also have a required place to explain their code. Those are useful starting materials for a demo or tutorial.

I also got several repair rounds. Choosing a cheaper model didn’t eliminate supervision, and I haven’t measured total cost well enough to claim savings. The factory’s review and preview stages caught some failures and missed others.

The next test is closer to my actual job: take a generated project, prepare a demo from its tutorial, trace a confusing change through Entire, and extend it confidently. That’s where I’ll find out whether Glasstown saves me work. At least I’ve kept the evidence needed to figure out what happened.
