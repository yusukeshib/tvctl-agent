@preconcurrency import AVFoundation
import Foundation

/// The audio format of `audio` events and `pcm` commands.
let streamFormat = AVAudioFormat(commonFormat: .pcmFormatInt16, sampleRate: 24000, channels: 1, interleaved: true)!
private let playFormat = AVAudioFormat(standardFormatWithSampleRate: 24000, channels: 1)!

/// A full-duplex voice link for a speech-to-speech model: streams the microphone continuously and plays the
/// model's speech on the same engine, with Apple's voice processing so our own speech is cancelled from the
/// microphone (the user can talk over it).
final class Converse: @unchecked Sendable {
    private let engine = AVAudioEngine()
    private let node = AVAudioPlayerNode()
    private var converter: AVAudioConverter?
    private var monoFormat: AVAudioFormat?
    private let levels: Bool
    private var observer: NSObjectProtocol?

    // Main queue only.
    private var current: String?
    private var scheduledFrames: Int64 = 0
    private var pending = 0
    private var ended = false

    // Tap thread only.
    private var channelDb: [Float] = []
    private var lastLevelMs: Double = 0

    private let voiceProcessing: Bool

    init(levels: Bool, voiceProcessing: Bool) {
        self.levels = levels
        self.voiceProcessing = voiceProcessing
    }

    func run() throws {
        try start()
        observer = NotificationCenter.default.addObserver(forName: .AVAudioEngineConfigurationChange, object: engine, queue: .main) { [weak self] _ in
            self?.restart()
        }
    }

    private func start() throws {
        let input = engine.inputNode
        // Build the output graph first: voice processing initializes the input and output units together.
        engine.attach(node)
        engine.connect(node, to: engine.mainMixerNode, format: playFormat)
        _ = engine.outputNode
        try input.setVoiceProcessingEnabled(voiceProcessing)
        // Voice processing ducks all other audio by default; tvctl ducks the player itself, only while we speak.
        if voiceProcessing, #available(macOS 14.0, *) {
            input.voiceProcessingOtherAudioDuckingConfiguration = .init(enableAdvancedDucking: false, duckingLevel: .min)
        }
        let format = input.outputFormat(forBus: 0)
        guard format.sampleRate > 0, format.channelCount > 0 else { throw Failure("input device has no audio format") }
        // Voice processing reports several channels; the processed microphone is the first one. Converting
        // all of them to mono gave silence, so convert only channel 0.
        guard let mono = AVAudioFormat(standardFormatWithSampleRate: format.sampleRate, channels: 1) else { throw Failure("no mono format") }
        monoFormat = mono
        converter = AVAudioConverter(from: mono, to: streamFormat)
        input.installTap(onBus: 0, bufferSize: 2400, format: format) { [weak self] buffer, _ in
            self?.handle(buffer)
        }
        engine.prepare()
        try engine.start()
        Out.emit("ready", ["input_rate": format.sampleRate, "channels": Int(format.channelCount), "voice_processing": voiceProcessing])
    }

    /// The device changed or went away: start again, retrying until it is back.
    private func restart() {
        stop()
        engine.stop()
        engine.inputNode.removeTap(onBus: 0)
        engine.detach(node)
        do {
            try start()
        } catch {
            Out.emit("device_lost", ["message": "\(error)"])
            DispatchQueue.main.asyncAfter(deadline: .now() + 2) { [weak self] in self?.restart() }
        }
    }

    private func handle(_ buffer: AVAudioPCMBuffer) {
        if levels { level(buffer) }
        guard let pcm = pcm16(buffer) else { return }
        Out.emit("audio", ["pcm": pcm.base64EncodedString()])
    }

    // MARK: playback (main queue)

    func chunk(id: String, pcm: Data) {
        if current != id {
            stop()
            current = id
            scheduledFrames = 0
            pending = 0
            ended = false
            Out.emit("speaking", ["id": id])
        }
        let frames = pcm.count / 2
        guard frames > 0, let buffer = AVAudioPCMBuffer(pcmFormat: playFormat, frameCapacity: AVAudioFrameCount(frames)) else { return }
        buffer.frameLength = AVAudioFrameCount(frames)
        pcm.withUnsafeBytes { raw in
            let samples = raw.bindMemory(to: Int16.self)
            let out = buffer.floatChannelData![0]
            for i in 0..<frames { out[i] = Float(Int16(littleEndian: samples[i])) / 32768 }
        }
        scheduledFrames += Int64(frames)
        pending += 1
        node.scheduleBuffer(buffer) { [weak self] in
            DispatchQueue.main.async { self?.played(id) }
        }
        if !node.isPlaying { node.play() }
    }

    func end(id: String) {
        guard current == id else {
            Out.emit("spoken", ["id": id])
            return
        }
        ended = true
        if pending == 0 { finish(stopped: false) }
    }

    /// Stops speaking now (the user talks over us) and reports how much was heard.
    func stop() {
        guard let id = current else { return }
        var heard = scheduledFrames
        if let render = node.lastRenderTime, let time = node.playerTime(forNodeTime: render) {
            heard = min(heard, max(0, time.sampleTime))
        }
        node.stop()
        current = nil
        Out.emit("stopped", ["id": id, "played_ms": Int(Double(heard) / 24)])
    }

    private func played(_ id: String) {
        guard current == id else { return }
        pending -= 1
        if pending == 0 && ended { finish(stopped: false) }
    }

    private func finish(stopped: Bool) {
        guard let id = current else { return }
        current = nil
        node.stop()
        Out.emit("spoken", ["id": id])
    }

    // MARK: audio helpers (tap thread)

    /// The buffer as 24 kHz mono PCM16 bytes.
    private func pcm16(_ input: AVAudioPCMBuffer) -> Data? {
        guard let converter, let monoFormat, let source = input.floatChannelData,
              let buffer = AVAudioPCMBuffer(pcmFormat: monoFormat, frameCapacity: input.frameLength) else { return nil }
        buffer.frameLength = input.frameLength
        buffer.floatChannelData![0].update(from: source[0], count: Int(input.frameLength))
        let ratio = streamFormat.sampleRate / buffer.format.sampleRate
        let capacity = AVAudioFrameCount((Double(buffer.frameLength) * ratio).rounded(.up)) + 16
        guard let out = AVAudioPCMBuffer(pcmFormat: streamFormat, frameCapacity: capacity) else { return nil }
        var consumed = false
        var error: NSError?
        converter.convert(to: out, error: &error) { _, status in
            if consumed {
                status.pointee = .noDataNow
                return nil
            }
            consumed = true
            status.pointee = .haveData
            return buffer
        }
        guard error == nil, out.frameLength > 0, let data = out.int16ChannelData else { return nil }
        return Data(bytes: data[0], count: Int(out.frameLength) * 2)
    }

    private func level(_ buffer: AVAudioPCMBuffer) {
        guard let data = buffer.floatChannelData, buffer.frameLength > 0 else { return }
        let n = Int(buffer.frameLength)
        for c in 0..<Int(buffer.format.channelCount) {
            var sum: Float = 0
            for i in 0..<n { sum += data[c][i] * data[c][i] }
            let rms = (sum / Float(n)).squareRoot()
            if channelDb.count <= c { channelDb.append(-160) }
            channelDb[c] = max(channelDb[c], rms > 0 ? 20 * log10(rms) : -160)
        }
        let now = Out.ms()
        if now - lastLevelMs >= 500 {
            Out.emit("level", ["db": channelDb.map { Double($0.rounded()) }])
            channelDb = channelDb.map { _ in -160 }
            lastLevelMs = now
        }
    }
}

struct Failure: Error, CustomStringConvertible {
    let description: String
    init(_ description: String) { self.description = description }
}
