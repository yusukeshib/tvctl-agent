@preconcurrency import AVFoundation
import AudioToolbox
import CoreMedia
import Foundation
import Speech

struct ListenOptions {
    var device: String?
    /// Feed this audio file in real time instead of a device (for tests).
    var file: String?
    var locale: String = "ja-JP"
    /// Level above which a buffer counts as speech (dBFS). nil: adaptive, `adaptiveMarginDb` above the noise floor.
    var speechThresholdDb: Float?
    var adaptiveMarginDb: Float = 15
    /// Silence after speech that ends an utterance (ms).
    var endSilenceMs: Double = 500
    /// Emit the peak level every 500 ms (for choosing the threshold).
    var levels = false
    /// Also emit each utterance's audio (`audio` events: base64 PCM16, 24 kHz mono), from `prerollMs`
    /// before speech_start until speech_end, for a cloud transcriber.
    var streamAudio = false
    var prerollMs: Double = 400
}

/// The audio format of `audio` events.
let streamFormat = AVAudioFormat(commonFormat: .pcmFormatInt16, sampleRate: 24000, channels: 1, interleaved: true)!

/// Captures one input device and streams transcripts.
final class Listener: @unchecked Sendable {
    private let options: ListenOptions
    private let engine = AVAudioEngine()
    private var analyzer: SpeechAnalyzer?
    private var transcriber: SpeechTranscriber?
    private var continuation: AsyncStream<AnalyzerInput>.Continuation?
    private var converter: AVAudioConverter?
    private var analyzerFormat: AVAudioFormat?

    // Audio timeline in analyzer samples; touched only on the tap thread.
    private var samples: Int64 = 0
    private var speaking = false
    private var lastSpeechMs: Double = 0
    private var utterance = 0
    private var peakDb: Float = -160
    private var lastLevelMs: Double = 0
    private var noiseFloorDb: Float = -60
    private var inputFormat: AVAudioFormat?
    private var observer: NSObjectProtocol?
    private var streamConverter: AVAudioConverter?
    /// Recent audio before speech starts, oldest first (tap thread only).
    private var preroll: [Data] = []
    private var prerollBytes = 0

    init(options: ListenOptions) {
        self.options = options
    }

    func run() async throws {
        guard SpeechTranscriber.isAvailable else { throw Failure("SpeechTranscriber is not available on this Mac") }
        guard let locale = await SpeechTranscriber.supportedLocale(equivalentTo: Locale(identifier: options.locale)) else {
            throw Failure("locale \(options.locale) is not supported")
        }
        let transcriber = SpeechTranscriber(locale: locale,
                                            transcriptionOptions: [],
                                            reportingOptions: [.volatileResults, .fastResults],
                                            attributeOptions: [])
        self.transcriber = transcriber
        try await ensureAssets(for: transcriber, locale: locale)

        let analyzer = SpeechAnalyzer(modules: [transcriber],
                                      options: .init(priority: .userInitiated, modelRetention: .processLifetime))
        self.analyzer = analyzer

        let file = try options.file.map { try AVAudioFile(forReading: URL(fileURLWithPath: $0)) }
        guard let format = await SpeechAnalyzer.bestAvailableAudioFormat(compatibleWith: [transcriber], considering: file?.processingFormat) else {
            throw Failure("no audio format compatible with the transcriber")
        }
        analyzerFormat = format
        try await analyzer.prepareToAnalyze(in: format)

        let (stream, continuation) = AsyncStream<AnalyzerInput>.makeStream()
        self.continuation = continuation

        let results = Task { [weak self] in
            do {
                for try await result in transcriber.results {
                    self?.report(result)
                }
            } catch {
                Out.error("results: \(error)")
            }
        }

        try await analyzer.start(inputSequence: stream)
        if let file {
            converter = AVAudioConverter(from: file.processingFormat, to: format)
            streamConverter = AVAudioConverter(from: file.processingFormat, to: streamFormat)
            Thread.detachNewThread { [weak self] in self?.play(file) }
        } else {
            try startDevice()
            observer = NotificationCenter.default.addObserver(forName: .AVAudioEngineConfigurationChange, object: engine, queue: .main) { [weak self] _ in
                self?.restartDevice()
            }
        }
        Out.emit("ready", [
            "locale": locale.identifier,
            "device": file == nil ? currentDeviceName() : options.file!,
            "input_rate": inputFormat?.sampleRate ?? file?.processingFormat.sampleRate ?? 0,
            "analyzer_rate": format.sampleRate,
        ])
        _ = await results.result
    }

    private func startDevice() throws {
        guard let format = analyzerFormat else { return }
        try selectDevice()
        let input = engine.inputNode
        let inputFormat = input.outputFormat(forBus: 0)
        guard inputFormat.sampleRate > 0, inputFormat.channelCount > 0 else { throw Failure("input device has no audio format") }
        self.inputFormat = inputFormat
        converter = AVAudioConverter(from: inputFormat, to: format)
        streamConverter = AVAudioConverter(from: inputFormat, to: streamFormat)
        input.installTap(onBus: 0, bufferSize: 1024, format: inputFormat) { [weak self] buffer, _ in
            self?.handle(buffer)
        }
        engine.prepare()
        try engine.start()
    }

    /// The device changed or went away: start again, retrying until it is back.
    private func restartDevice() {
        engine.stop()
        engine.inputNode.removeTap(onBus: 0)
        do {
            try startDevice()
            Out.emit("device", ["device": currentDeviceName(), "input_rate": inputFormat?.sampleRate ?? 0])
        } catch {
            Out.emit("device_lost", ["message": "\(error)"])
            DispatchQueue.main.asyncAfter(deadline: .now() + 2) { [weak self] in self?.restartDevice() }
        }
    }

    /// Feeds a file at real-time pace, then 3 s of silence, like a device would.
    private func play(_ file: AVAudioFile) {
        let format = file.processingFormat
        let frames: AVAudioFrameCount = 1024
        let seconds = Double(frames) / format.sampleRate
        var silence = Int(3 / seconds)
        while true {
            guard let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: frames) else { return }
            if (try? file.read(into: buffer, frameCount: frames)) == nil || buffer.frameLength == 0 {
                guard silence > 0 else { break }
                silence -= 1
                buffer.frameLength = frames
                for c in 0..<Int(format.channelCount) {
                    buffer.floatChannelData?[c].update(repeating: 0, count: Int(frames))
                }
            }
            handle(buffer)
            Thread.sleep(forTimeInterval: seconds)
        }
        Out.emit("file_end")
    }

    private func ensureAssets(for transcriber: SpeechTranscriber, locale: Locale) async throws {
        let installed = await SpeechTranscriber.installedLocales
        if installed.contains(where: { $0.identifier(.bcp47) == locale.identifier(.bcp47) }) { return }
        Out.emit("status", ["message": "downloading speech model for \(locale.identifier)"])
        if let request = try await AssetInventory.assetInstallationRequest(supporting: [transcriber]) {
            try await request.downloadAndInstall()
        }
        Out.emit("status", ["message": "speech model installed"])
    }

    private func selectDevice() throws {
        guard let query = options.device else { return }
        guard let device = findInputDevice(query) else {
            let names = listInputDevices().map(\.name).joined(separator: ", ")
            throw Failure("input device \"\(query)\" not found (available: \(names))")
        }
        guard let unit = engine.inputNode.audioUnit else { throw Failure("input node has no audio unit") }
        var id = device.id
        let status = AudioUnitSetProperty(unit, kAudioOutputUnitProperty_CurrentDevice, kAudioUnitScope_Global, 0,
                                          &id, UInt32(MemoryLayout<AudioDeviceID>.size))
        guard status == noErr else { throw Failure("could not select input device \(device.name) (\(status))") }
    }

    private func currentDeviceName() -> String {
        guard let unit = engine.inputNode.audioUnit else { return "" }
        var id = AudioDeviceID(0)
        var size = UInt32(MemoryLayout<AudioDeviceID>.size)
        guard AudioUnitGetProperty(unit, kAudioOutputUnitProperty_CurrentDevice, kAudioUnitScope_Global, 0, &id, &size) == noErr else { return "" }
        return listInputDevices().first(where: { $0.id == id })?.name ?? "\(id)"
    }

    private func handle(_ buffer: AVAudioPCMBuffer) {
        guard let converter, let format = analyzerFormat, let continuation else { return }
        let ratio = format.sampleRate / buffer.format.sampleRate
        let capacity = AVAudioFrameCount((Double(buffer.frameLength) * ratio).rounded(.up)) + 16
        guard let out = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: capacity) else { return }
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
        if let error {
            Out.error("convert: \(error.localizedDescription)")
            return
        }
        guard out.frameLength > 0 else { return }
        let start = CMTime(value: samples, timescale: CMTimeScale(format.sampleRate))
        samples += Int64(out.frameLength)
        // While we speak (and shortly after), the mic hears our own voice: transcribe silence instead.
        if SelfSpeech.active() {
            for c in 0..<Int(format.channelCount) {
                out.floatChannelData?[c].update(repeating: 0, count: Int(out.frameLength))
            }
            continuation.yield(AnalyzerInput(buffer: out, bufferStartTime: start))
            return
        }
        continuation.yield(AnalyzerInput(buffer: out, bufferStartTime: start))
        detectSpeech(buffer, end: CMTime(value: samples, timescale: CMTimeScale(format.sampleRate)))
        if options.streamAudio, let pcm = streamChunk(buffer) {
            if speaking {
                Out.emit("audio", ["utterance": utterance, "pcm": pcm.base64EncodedString()])
            } else {
                preroll.append(pcm)
                prerollBytes += pcm.count
                let max = Int(options.prerollMs / 1000 * 24000 * 2)
                while prerollBytes > max, let first = preroll.first {
                    prerollBytes -= first.count
                    preroll.removeFirst()
                }
            }
        }
    }

    /// The buffer as 24 kHz mono PCM16 bytes.
    private func streamChunk(_ buffer: AVAudioPCMBuffer) -> Data? {
        guard let streamConverter else { return nil }
        let ratio = streamFormat.sampleRate / buffer.format.sampleRate
        let capacity = AVAudioFrameCount((Double(buffer.frameLength) * ratio).rounded(.up)) + 16
        guard let out = AVAudioPCMBuffer(pcmFormat: streamFormat, frameCapacity: capacity) else { return nil }
        var consumed = false
        var error: NSError?
        streamConverter.convert(to: out, error: &error) { _, status in
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

    /// Energy gate: marks speech start and, after enough silence, finalizes the transcript.
    private func detectSpeech(_ buffer: AVAudioPCMBuffer, end: CMTime) {
        let db = level(buffer)
        let now = Out.ms()
        if options.levels {
            peakDb = max(peakDb, db)
            if now - lastLevelMs >= 500 {
                Out.emit("level", ["db": Double(peakDb.rounded())])
                peakDb = -160
                lastLevelMs = now
            }
        }
        // Exact digital silence (a muted mic) never counts toward the noise floor.
        if !speaking && db > -150 {
            noiseFloorDb = noiseFloorDb * 0.98 + db * 0.02
        }
        let threshold = options.speechThresholdDb ?? max(noiseFloorDb + options.adaptiveMarginDb, -65)
        if db > threshold {
            lastSpeechMs = now
            if !speaking {
                speaking = true
                utterance += 1
                Out.emit("speech_start", ["utterance": utterance, "db": Double(db)])
                if options.streamAudio {
                    for pcm in preroll {
                        Out.emit("audio", ["utterance": utterance, "pcm": pcm.base64EncodedString()])
                    }
                    preroll.removeAll()
                    prerollBytes = 0
                }
            }
        } else if speaking && now - lastSpeechMs >= options.endSilenceMs {
            speaking = false
            let id = utterance
            Out.emit("speech_end", ["utterance": id])
            let analyzer = self.analyzer
            Task {
                do {
                    try await analyzer?.finalize(through: end)
                    Out.emit("finalized", ["utterance": id])
                } catch {
                    Out.error("finalize: \(error)")
                }
            }
        }
    }

    private func level(_ buffer: AVAudioPCMBuffer) -> Float {
        guard let data = buffer.floatChannelData, buffer.frameLength > 0 else { return -160 }
        let n = Int(buffer.frameLength)
        var sum: Float = 0
        let samples = data[0]
        for i in 0..<n { sum += samples[i] * samples[i] }
        let rms = (sum / Float(n)).squareRoot()
        return rms > 0 ? 20 * log10(rms) : -160
    }

    private func report(_ result: SpeechTranscriber.Result) {
        let text = String(result.text.characters)
        let fields: [String: Any] = [
            "text": text,
            "start": result.range.start.seconds,
            "end": CMTimeRangeGetEnd(result.range).seconds,
        ]
        Out.emit(result.isFinal ? "final" : "partial", fields)
    }
}

struct Failure: Error, CustomStringConvertible {
    let description: String
    init(_ description: String) { self.description = description }
}
