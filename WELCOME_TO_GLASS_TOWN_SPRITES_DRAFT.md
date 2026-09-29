# Welcome to Glass Town

Steve Yegge describes Gas Town’s workers as “superintelligent robot chimps” and compares the setup to a factory with “machines that can disembowel you if you’re not careful.” [Encouraging stuff](https://yegge.ai/essays/welcome-to-gas-town/).

Everyone seems to be building a software factory. Obviously, I needed one too.

I’d already played with [Goosetown](https://github.com/aaif-goose/goosetown), which coordinates agents to research, build, and review work. I wanted a smaller version using Codex, with enough history to understand how its output happened.

In [Welcome to Gas City](https://steve-yegge.medium.com/welcome-to-gas-city-57f564bb3607), Yegge defines a dark factory:

> A dark factory is any system in which coding agents are set up to work autonomously without humans watching.

He also makes clear that unattended work can be observable. I wanted that visibility built into delivery: the app, its code, captured sessions, and an explanation I could learn from.

Hence, Glasstown.

I work in developer relations. Generating a demo could save me time, provided I understand it well enough to teach it and answer questions when it breaks. That was the experiment. For an extra challenge, the factory would live in a Sprite.

## Give the factory a home

A Sprite is a remote Linux computer from Fly.io with persistent storage. I can install tools, clone repositories, and run servers there. The files stay between sessions, including the dependencies I’d otherwise spend time reinstalling. [Fly’s quickstart](https://docs.fly.io/sprites/quickstart) covers installing the CLI; once it’s available, these commands run on my Mac:

```sh
sprite login
sprite create glasstown-demo --skip-console
sprite console -s glasstown-demo --no-port-forward
```

The first command authenticates, the second creates a new environment, and the third opens its shell. `--skip-console` keeps creation and connection separate; `--no-port-forward` leaves forwarding for later.

Commands typed after connecting now run on the Sprite. For example:

```sh
mkdir -p /home/sprite/projects
node --version
python3 --version
```

I’m checking the remote runtimes. My laptop’s Python installation has nothing to do with those results. `exit` takes me back to my Mac.

My actual factory Sprite is named `mcp-rizel-codextown`, so that’s the name in the remaining examples. To inspect its projects without opening an interactive shell, I can run:

```sh
sprite exec -s mcp-rizel-codextown --no-stdin -- \
  ls /home/sprite/projects
```

`console` gives me a shell to work in; `exec` runs a particular command and returns its output. Those two operations cover much of what I need while building and debugging.

## Move the workers in

The factory checkout lives at `/home/sprite/software-factory`. Each product gets a separate directory under `/home/sprite/projects/` and its own private GitHub repo. Starting another project doesn’t mean emptying the previous one.

These folders share the Sprite’s resources and available credentials. If I want separate machines, I need separate Sprites. The factory currently reuses one configured environment.

Getting the logins right took some patience. My Mac needed Sprite access. Codex inside the Sprite needed its own OpenAI login. Git inside it needed GitHub access. A browser approval on my Mac had to complete the login for the remote process that requested it.

Once configured, Glasstown’s current workers run in sequence:

- **Planner:** reads the agreed project brief and proposes implementation steps.
- **Builder:** writes code, runs tests, and commits and pushes changes.
- **Tutorial writer:** explains the implementation in `tutorial.md`.
- **Reviewer:** checks the code and tutorial, approving or rejecting delivery.
- **Preview worker:** starts the approved app and checks its HTTP response.

The first four use Codex with `gpt-5.6-luna` and low reasoning. The preview worker is ordinary code. I don’t need a model to have a think about opening a port.

The Town Wall displays progress, while Entire records Codex sessions and links them to commits. The workers pass saved artifacts along; they don’t currently chat with one another. That’s the extent of my town’s social life.

## Give it a job

I asked Glasstown to build a music app for someone who doesn’t know how to play an instrument. Move my fingers in the air, hear music, and show me the notes and chords.

We narrowed that to Airkeys: a browser app with one octave of piano-like notes, MediaPipe hand tracking, chord assistance, and a short exercise. Point into a labeled note zone and pinch to play. Release before playing again. Mouse and keyboard controls provide a fallback.

The accepted scope went into `PROJECT_BRIEF.md` before starting the workers. Remote agents don’t automatically inherit the conversation where I decided what I wanted.

Airkeys landed in `/home/sprite/projects/airkeys`. Its files, dependencies, Git history, and preview server were now on the Sprite.

Which raised a question: how do I actually see it?

## The app is over there. The browser is over here.

After review approves a build, the preview worker starts a server inside the Sprite. A listening remote port still needs a route from my browser.

That’s what `sprite proxy` supplies. If Airkeys is listening on remote port 3002, I can run this on my Mac:

```sh
sprite proxy -s mcp-rizel-codextown 13002:3002
```

The numbers mean **local port 13002 → Sprite port 3002**. In another Mac terminal:

```sh
open -a 'Google Chrome' http://localhost:13002/
```

Requests to that localhost address travel through the authenticated connection to the remote server. The proxy terminal must stay open. Closing it cuts the connection; it doesn’t delete Airkeys. If the local port is occupied, I choose another one. The remote server’s port can stay the same. [The networking guide](https://docs.fly.io/sprites/working-with-sprites/) explains the forwarding options.

This finally made localhost click for me. The project hadn’t somehow moved onto my computer. I was reaching another computer through a local address.

But the frontend JavaScript does run locally once Chrome downloads it. Airkeys processes camera frames and synthesizes audio in the browser, using my webcam and speakers. The Sprite serves the files. Nobody needs to ship Fly.io a piano.

Sprites also have HTTP URLs; a local tunnel is one access option. I kept this preview private. A localhost address is useful on my machine, but sending it to someone else won’t let them visit my app.

Opening the browser also exposed a limitation in the factory. Review had approved Airkeys, but interaction checks found that a selector highlighted the guide labels instead of the playable keys. The server’s successful response hadn’t proved the interface worked.

We repaired it and reran checks. Automated tests covered camera startup with a synthetic feed and simulated gestures. Actual hand-tracking feel still needed a human try. Hosting worked; musical ability remained outside the service agreement.

## Leave, return, and recover

Persistent files don’t imply an uninterrupted process. Sprites can pause when idle. A warm pause preserves process state, but a cold transition drops it; network connections can also break. A long-running job needs lifecycle handling beyond leaving files on disk. [Fly documents those distinctions here](https://docs.fly.io/sprites/keeping-sprites-running).

For the preview, Glasstown registers a Sprite service. The runtime can restart that server after a cold wake. For a plain Node server, the same mechanism can be configured inside a Sprite:

```sh
sprite-env services create my-web-app \
  --cmd node --args /home/sprite/projects/my-web-app/server.js
```

That example assumes the server file exists. Registering a service tells the runtime how to launch it; it doesn’t create the application. My foreground factory runs also don’t become a durable background queue just because their workspace is persistent.

There’s another useful feature for experiments: filesystem checkpoints. From my Mac, before changing the environment, I can run:

```sh
sprite checkpoint create -s mcp-rizel-codextown \
  --comment 'Before changing the factory environment'
```

A Sprite checkpoint can restore the environment’s filesystem, including installed tools. An Entire checkpoint records agent context associated with code changes. Git preserves committed source. Each answers a different recovery or inspection question.

Restoring the Sprite affects its filesystem as a whole, including other projects sharing it. It isn’t a surgical undo for one file. Automatic Sprite checkpointing isn’t part of my factory yet; this is an operation I can perform myself.

## Run the factory again

An agent can operate Sprites through MCP. I can also submit work directly from the factory checkout on my Mac:

```sh
python3 codextown_client.py \
  --repo /home/sprite/projects/airkeys \
  'Improve camera onboarding and update tutorial.md.'
```

This expects the configured Sprite and prepared project. It invokes Codex workers, waits for approval, connects the preview, and opens Chrome. To reopen a saved preview without another model run:

```sh
python3 codextown_client.py --open-run RUN_ID
```

The [cookbook](LEARNINGS.md#15-terminal-cookbook-operate-this-yourself) covers the full setup. The tutorial writer was added after the first Airkeys build, making an explanation part of subsequent deliveries.

I came away with a reusable factory and a clearer understanding of its computer: where commands execute, where files live, how a browser reaches them, and what survives when I disconnect.

Airkeys took repairs, and I haven’t measured the total cost or time savings. The next DevRel test is preparing a demo from a generated project and its tutorial. I now have somewhere to keep that experiment, run it, inspect it, and come back to it.
