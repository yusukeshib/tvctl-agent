import Foundation

/// Writes one JSON object per line to stdout, from any thread.
enum Out {
    private static let queue = DispatchQueue(label: "tvctl-voice.out")
    private static let start = DispatchTime.now().uptimeNanoseconds

    static func ms() -> Double {
        // Read `start` first: it is initialized lazily on first use.
        let origin = start
        return Double(DispatchTime.now().uptimeNanoseconds - origin) / 1_000_000
    }

    static func emit(_ type: String, _ fields: [String: Any] = [:]) {
        var object = fields
        object["type"] = type
        object["t"] = (ms() * 10).rounded() / 10
        queue.async {
            guard let data = try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys, .withoutEscapingSlashes]) else { return }
            FileHandle.standardOutput.write(data)
            FileHandle.standardOutput.write(Data([0x0A]))
        }
    }

    static func error(_ message: String) {
        emit("error", ["message": message])
    }
}
