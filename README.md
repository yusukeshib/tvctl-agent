# tvctl-agent

Talk with your TV. A voice agent for [tvctl](https://github.com/yusukeshib/tvctl):
you speak naturally, it answers with its voice and drives the player (search,
play, pause, seek, volume, subtitles, ...). It can only use its own tools
(tvctl and web search); it never gets a shell or a browser.

The conversation is one OpenAI Realtime speech-to-speech session
(`gpt-realtime-2.1`), like the ChatGPT app's voice mode: the model decides when
you have finished speaking, answers at once, calls the tools, and stops when you
talk over it. Needs `OPENAI_API_KEY` (from the environment or your login shell).

Work in progress. macOS 26 or later on Apple silicon.

## Parts

- `voice/`: `tvctl-voice`, a Swift helper. It streams the default microphone
  with Apple's voice processing (echo cancellation, so the agent does not hear
  itself) and plays the agent's speech. JSON lines on stdin/stdout.
- `src/`: the agent daemon (Node.js, TypeScript): the Realtime session
  (`realtime.ts`), the tools (`tools.ts`), and the conversation log (`memory.ts`).

## Install

```sh
scripts/install-launchd.sh          # builds the helper, installs a launchd agent (starts at login)
scripts/install-launchd.sh uninstall
```

Configuration: `~/.config/tvctl-agent/config.toml` (see `config.example.toml`;
every key is optional). Log: `~/Library/Logs/tvctl-agent/agent.log`.

Try one typed message (text only, no microphone):

```sh
node src/main.ts --text "一時停止して"
```

While the agent speaks, `tvctl duck` lowers the player (`speech.duck_level`).

## Memory

Every turn (what you said, the spoken replies, tool calls) is appended to
`~/Library/Application Support/tvctl-agent/conversation.jsonl`. A Realtime
session lasts at most 60 minutes; the agent renews it at a quiet moment, and
each new session starts with the latest part of the log (`memory.recent_chars`).

## Logs

`agent.log` has one readable line per event: each turn of speech (`[turn]`), what the model heard
(`[heard]`), each response with its status, latency and token use (`[response]`), the context it had
(item counts), spoken answers (`[answer]`), interruptions with how much was heard (`[interrupt]`), tool
runs with their result and duration (`[tool]`), and session starts, renewals and reconnects (`[session]`).

The full trace of each run is in `~/Library/Logs/tvctl-agent/traces/<run>/events.jsonl`: every
Realtime event both ways (the instructions included, audio left out) plus the agent's own events, such
as `agent.context` (the conversation the model had when each response started). With `log.audio = true`
the run also keeps WAV files of what the model heard and said. For example:

```sh
cd ~/Library/Logs/tvctl-agent/traces/$(ls -t ~/Library/Logs/tvctl-agent/traces | head -1)
jq -c 'select(.type == "response.done") | .response | {status, status_details, usage}' events.jsonl
jq -c 'select(.type == "agent.context") | .items' events.jsonl | tail -1
```

## voice helper

```sh
cd voice && swift build -c release
.build/release/tvctl-voice devices     # input devices
.build/release/tvctl-voice converse    # stream the microphone, play speech (see --help)
```
