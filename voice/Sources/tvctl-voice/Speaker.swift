@preconcurrency import AVFoundation
import Foundation

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

    func speak(id: String, text: String) {
        let utterance = AVSpeechUtterance(string: text)
        if let voiceIdentifier, let voice = AVSpeechSynthesisVoice(identifier: voiceIdentifier) {
            utterance.voice = voice
        } else {
            utterance.voice = AVSpeechSynthesisVoice(language: language)
        }
        if let rate { utterance.rate = rate }
        ids[ObjectIdentifier(utterance)] = id
        synthesizer.speak(utterance)
    }

    func stop() {
        synthesizer.stopSpeaking(at: .immediate)
    }

    func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didStart utterance: AVSpeechUtterance) {
        if let id = ids[ObjectIdentifier(utterance)] { Out.emit("speaking", ["id": id]) }
    }

    func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didFinish utterance: AVSpeechUtterance) {
        if let id = ids.removeValue(forKey: ObjectIdentifier(utterance)) { Out.emit("spoken", ["id": id]) }
    }

    func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didCancel utterance: AVSpeechUtterance) {
        if let id = ids.removeValue(forKey: ObjectIdentifier(utterance)) { Out.emit("spoken", ["id": id, "cancelled": true]) }
    }
}
