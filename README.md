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

## voice helper

```sh
cd voice && swift build -c release
.build/release/tvctl-voice devices                      # input devices
.build/release/tvctl-voice listen --device "MacBook Pro Microphone"
.build/release/tvctl-voice listen --file command.aiff   # a file, fed in real time
```
