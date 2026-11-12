import AVFoundation
import Foundation

let usage = """
usage: tvctl-voice devices
       tvctl-voice converse [--levels]

converse streams the default microphone (echo-cancelled) and plays speech, as JSON lines.
stdout: ready, audio {"pcm":"<base64 PCM16 24 kHz mono>"}, speaking {"id"}, spoken {"id"},
        stopped {"id","played_ms"}, level, device_lost, error
stdin:  {"type":"pcm","id":"1","data":"<base64 PCM16 24 kHz mono>"}  {"type":"pcm_end","id":"1"}  {"type":"stop"}
"""

func readCommands(_ converse: Converse) {
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
                    if let pcm = Data(base64Encoded: object["data"] as? String ?? "") { converse.chunk(id: id, pcm: pcm) }
                case "pcm_end":
                    converse.end(id: id)
                case "stop":
                    converse.stop()
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
case "converse":
    let converse = Converse(levels: args.contains("--levels"))
    readCommands(converse)
    do {
        try converse.run()
    } catch {
        FileHandle.standardError.write(Data("tvctl-voice: \(error)\n".utf8))
        exit(1)
    }
    RunLoop.main.run()
default:
    FileHandle.standardError.write(Data((usage + "\n").utf8))
    exit(args.isEmpty ? 0 : 2)
}
