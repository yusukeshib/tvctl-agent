import AVFoundation
import Foundation

let usage = """
usage: tvctl-voice devices
       tvctl-voice listen [--device NAME|UID | --file AUDIO] [--threshold-db DB | --margin-db 15] [--end-silence-ms 500] [--levels]

listen writes JSON lines on stdout:
  ready, speech_start, audio {"utterance":1,"pcm":"<base64 PCM16 24 kHz mono>"}, speech_end,
  speaking, spoken, device, device_lost, level, error
and reads JSON lines on stdin (speech to play, PCM16 24 kHz mono):
  {"type":"pcm","id":"1","data":"<base64>"}   {"type":"pcm_end","id":"1"}   {"type":"stop_speaking"}
"""

func value(_ args: [String], _ name: String) -> String? {
    guard let i = args.firstIndex(of: name), i + 1 < args.count else { return nil }
    return args[i + 1]
}

func readCommands(_ player: Player) {
    Thread.detachNewThread {
        while let line = readLine() {
            if line.trimmingCharacters(in: .whitespaces).isEmpty { continue }
            guard let data = line.data(using: .utf8),
                  let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let type = object["type"] as? String else {
                Out.error("bad command: \(line)")
                continue
            }
            DispatchQueue.main.async {
                let id = object["id"] as? String ?? ""
                switch type {
                case "pcm":
                    if let pcm = Data(base64Encoded: object["data"] as? String ?? "") { player.chunk(id: id, pcm: pcm) }
                case "pcm_end":
                    player.end(id: id)
                case "stop_speaking":
                    player.stop()
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
case "listen":
    var options = ListenOptions()
    options.device = value(args, "--device")
    options.file = value(args, "--file")
    options.levels = args.contains("--levels")
    if let db = value(args, "--threshold-db").flatMap(Float.init) { options.speechThresholdDb = db }
    if let db = value(args, "--margin-db").flatMap(Float.init) { options.adaptiveMarginDb = db }
    if let ms = value(args, "--end-silence-ms").flatMap(Double.init) { options.endSilenceMs = ms }
    let player = Player()
    readCommands(player)
    let listener = Listener(options: options)
    do {
        try listener.run()
    } catch {
        Out.error("\(error)")
        exit(1)
    }
    RunLoop.main.run()
default:
    FileHandle.standardError.write(Data((usage + "\n").utf8))
    exit(args.isEmpty ? 0 : 2)
}
