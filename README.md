# tvctl-agent

An always-listening voice agent for [tvctl](https://github.com/yusukeshib/tvctl).
It listens to one audio input device, turns what you say into tvctl actions
(or short spoken answers), and keeps one never-ending conversation as its
memory (the OptChat design, on [pi-durable](https://www.npmjs.com/package/@earendil-works/pi-durable)).
It can only use its own tools: tvctl, search and memory. It never gets a shell
or a browser.

Work in progress. macOS 26 or later on Apple silicon.

## Parts

- `voice/`: `tvctl-voice`, a Swift helper. It captures the configured input
  device, transcribes it on device with Apple's SpeechAnalyzer, and speaks
  replies. JSON lines on stdin/stdout.
- `src/`: the agent daemon (Node.js, TypeScript).
- `scripts/bench-models.ts`: measures how fast candidate models pick the right
  tool for typical commands.

## Install

```sh
scripts/install-launchd.sh          # builds the helper, installs a launchd agent (starts at login)
scripts/install-launchd.sh uninstall
```

Configuration: `~/.config/tvctl-agent/config.toml` (see `config.example.toml`;
every key is optional). Log: `~/Library/Logs/tvctl-agent/agent.log`.

Try one command without the microphone:

```sh
node src/main.ts --text "一時停止して"
```

The default model is `anthropic/claude-haiku-5-5` through pi's login
(`~/.pi/agent/auth.json`, shared with pi's file lock, so token refreshes do not
conflict). `openai/...` models use `OPENAI_API_KEY`.

While the agent speaks, `tvctl duck` lowers the player (`speech.duck_level`).

## Memory

One chat that never ends, as in the OptChat design
([docs/optchat-spec.md](docs/optchat-spec.md), from
[Taelin's gist](https://gist.github.com/VictorTaelin/91837951a5ce5b38f341ec1ba1df6449)).
Every message (your words, replies, tool calls and results) is logged in
`optchat.sqlite` next to the pi-durable store and compressed in the background
into a binary tree of one-line summaries. Each command is a fresh model call
that sees the view (64-128 KB of summary lines, recent ones fine and old ones
coarse) and can `zoom` into any line. pi-durable runs the calls; its own
compaction is not used. Code: `src/optchat/`.

Differences from the spec: compactions use `low` thinking by default (the spec
uses `xhigh`; set `model.compactor_thinking`), and a turn waits at most
`memory.wait_ms` for earlier summaries.

## voice helper

```sh
cd voice && swift build -c release
.build/release/tvctl-voice devices                      # input devices
.build/release/tvctl-voice listen --device "MacBook Pro Microphone"
.build/release/tvctl-voice listen --file command.aiff   # a file, fed in real time
```
