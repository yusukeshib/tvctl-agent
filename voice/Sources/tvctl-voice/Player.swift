@preconcurrency import AVFoundation
import Foundation

/// Plays streamed PCM16 24 kHz mono speech (from a cloud voice) and reports when each request ends.
/// Commands arrive on the main queue: begin, chunk..., end; or stop.
final class Player: @unchecked Sendable {
    private let engine = AVAudioEngine()
    private let node = AVAudioPlayerNode()
    private let format = AVAudioFormat(standardFormatWithSampleRate: 24000, channels: 1)!
    /// The request being played: its id and the buffers not yet played.
    private var current: String?
    private var pending = 0
    private var ended = false
    private var started = false

    init() {
        engine.attach(node)
        engine.connect(node, to: engine.mainMixerNode, format: format)
    }

    func chunk(id: String, pcm: Data) {
        if current != id {
            stop()
            current = id
            pending = 0
            ended = false
            started = false
        }
        let frames = pcm.count / 2
        guard frames > 0, let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(frames)) else { return }
        buffer.frameLength = AVAudioFrameCount(frames)
        pcm.withUnsafeBytes { raw in
            let samples = raw.bindMemory(to: Int16.self)
            let out = buffer.floatChannelData![0]
            for i in 0..<frames { out[i] = Float(Int16(littleEndian: samples[i])) / 32768 }
        }
        if !engine.isRunning {
            engine.prepare()
            do { try engine.start() } catch {
                Out.error("player: \(error)")
                return
            }
        }
        if !started {
            started = true
            SelfSpeech.begin()
            Out.emit("speaking", ["id": id])
        }
        pending += 1
        node.scheduleBuffer(buffer) { [weak self] in
            DispatchQueue.main.async { self?.played(id) }
        }
        if !node.isPlaying { node.play() }
    }

    func end(id: String) {
        guard current == id else {
            // Nothing was played for it.
            Out.emit("spoken", ["id": id])
            return
        }
        ended = true
        if pending == 0 { finish(cancelled: false) }
    }

    func stop() {
        guard current != nil else { return }
        node.stop()
        finish(cancelled: true)
    }

    private func played(_ id: String) {
        guard current == id else { return }
        pending -= 1
        if pending == 0 && ended { finish(cancelled: false) }
    }

    private func finish(cancelled: Bool) {
        guard let id = current else { return }
        current = nil
        if started { SelfSpeech.end() }
        Out.emit("spoken", cancelled ? ["id": id, "cancelled": true] : ["id": id])
    }
}
