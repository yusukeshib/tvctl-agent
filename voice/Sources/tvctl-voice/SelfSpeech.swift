import Foundation

/// Whether our own speech may be in the microphone: while speaking and for a short tail after.
enum SelfSpeech {
    private static let lock = NSLock()
    private static var speaking = 0
    private static var quietAfterMs: Double = 0
    static let tailMs: Double = 400

    static func begin() {
        lock.lock(); speaking += 1; lock.unlock()
    }

    static func end() {
        lock.lock(); speaking = max(0, speaking - 1); quietAfterMs = Out.ms() + tailMs; lock.unlock()
    }

    static func active() -> Bool {
        lock.lock(); defer { lock.unlock() }
        return speaking > 0 || Out.ms() < quietAfterMs
    }
}
