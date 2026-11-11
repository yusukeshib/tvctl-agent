@preconcurrency import AVFoundation
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

/// Speaks text with the system synthesizer and reports when each request ends.
final class Speaker: NSObject, AVSpeechSynthesizerDelegate, @unchecked Sendable {
    private let synthesizer = AVSpeechSynthesizer()
    private var ids: [ObjectIdentifier: String] = [:]
    private let language: String
    private let voiceIdentifier: String?
    private let rate: Float?

    init(language: String, voiceIdentifier: String?, rate: Float?) {
        self.language = language
        self.voiceIdentifier = voiceIdentifier
        self.rate = rate
        super.init()
        synthesizer.delegate = self
    }

    /// The highest-quality installed voice for the language (premium > enhanced > compact).
    private lazy var bestVoice: AVSpeechSynthesisVoice? = {
        let voices = AVSpeechSynthesisVoice.speechVoices().filter { $0.language == language && !$0.identifier.contains("eloquence") }
        return voices.max(by: { $0.quality.rawValue < $1.quality.rawValue }) ?? AVSpeechSynthesisVoice(language: language)
    }()

    func speak(id: String, text: String) {
        let utterance = AVSpeechUtterance(string: text)
        if let voiceIdentifier, let voice = AVSpeechSynthesisVoice(identifier: voiceIdentifier) {
            utterance.voice = voice
        } else {
            utterance.voice = bestVoice
        }
        if let rate { utterance.rate = rate }
        ids[ObjectIdentifier(utterance)] = id
        SelfSpeech.begin()
        synthesizer.speak(utterance)
    }

    func stop() {
        synthesizer.stopSpeaking(at: .immediate)
    }

    func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didStart utterance: AVSpeechUtterance) {
        if let id = ids[ObjectIdentifier(utterance)] { Out.emit("speaking", ["id": id]) }
    }

    func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didFinish utterance: AVSpeechUtterance) {
        if let id = ids.removeValue(forKey: ObjectIdentifier(utterance)) {
            SelfSpeech.end()
            Out.emit("spoken", ["id": id])
        }
    }

    func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didCancel utterance: AVSpeechUtterance) {
        if let id = ids.removeValue(forKey: ObjectIdentifier(utterance)) {
            SelfSpeech.end()
            Out.emit("spoken", ["id": id, "cancelled": true])
        }
    }
}
