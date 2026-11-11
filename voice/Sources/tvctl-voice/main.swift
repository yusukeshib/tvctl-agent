import AVFoundation
import Foundation

let usage = """
usage: tvctl-voice devices
       tvctl-voice listen [--device NAME|UID | --file AUDIO] [--locale ja-JP] [--threshold-db -45] [--end-silence-ms 500]
                          [--voice IDENTIFIER] [--rate 0.5]
       tvctl-voice voices [--locale ja-JP]

listen streams JSON lines on stdout (ready, speech_start, partial, final, speech_end,
finalized, speaking, spoken, status, error) and reads JSON lines on stdin:
  {"type":"speak","id":"1","text":"..."}   {"type":"stop_speaking"}
"""

func value(_ args: [String], _ name: String) -> String? {
    guard let i = args.firstIndex(of: name), i + 1 < args.count else { return nil }
    return args[i + 1]
}

func readCommands(_ speaker: Speaker) {
    Thread.detachNewThread {
        while let line = readLine() {
            guard let data = line.data(using: .utf8),
                  let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let type = object["type"] as? String else {
                Out.error("bad command: \(line)")
                continue
            }
            DispatchQueue.main.async {
                switch type {
                case "speak":
                    speaker.speak(id: object["id"] as? String ?? "", text: object["text"] as? String ?? "")
                case "stop_speaking":
                    speaker.stop()
                default:
                    Out.error("unknown command: \(type)")
                }
            }
        }
        // stdin closed: the parent is gone.
        exit(0)
    }
}

let args = Array(CommandLine.arguments.dropFirst())
switch args.first {
case "devices":
    let list = listInputDevices().map { ["uid": $0.uid, "name": $0.name, "default": $0.isDefault] as [String: Any] }
    let data = try JSONSerialization.data(withJSONObject: list, options: [.prettyPrinted, .sortedKeys])
    print(String(decoding: data, as: UTF8.self))
case "voices":
    let locale = value(args, "--locale") ?? "ja-JP"
    let list = AVSpeechSynthesisVoice.speechVoices()
        .filter { $0.language == locale }
        .map { ["identifier": $0.identifier, "name": $0.name, "quality": $0.quality.rawValue] as [String: Any] }
    let data = try JSONSerialization.data(withJSONObject: list, options: [.prettyPrinted, .sortedKeys])
    print(String(decoding: data, as: UTF8.self))
case "listen":
    var options = ListenOptions()
    options.device = value(args, "--device")
    options.file = value(args, "--file")
    if let locale = value(args, "--locale") { options.locale = locale }
    if let db = value(args, "--threshold-db").flatMap(Float.init) { options.speechThresholdDb = db }
    if let ms = value(args, "--end-silence-ms").flatMap(Double.init) { options.endSilenceMs = ms }
    let speaker = Speaker(language: options.locale,
                          voiceIdentifier: value(args, "--voice"),
                          rate: value(args, "--rate").flatMap(Float.init))
    readCommands(speaker)
    let listener = Listener(options: options)
    Task {
        do {
            try await listener.run()
            Out.error("transcriber stopped")
            exit(1)
        } catch {
            Out.error("\(error)")
            // Let the output queue flush.
            try? await Task.sleep(nanoseconds: 100_000_000)
            exit(1)
        }
    }
    RunLoop.main.run()
default:
    FileHandle.standardError.write(Data((usage + "\n").utf8))
    exit(args.isEmpty ? 0 : 2)
}
