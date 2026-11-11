import CoreAudio
import Foundation

struct InputDevice {
    let id: AudioDeviceID
    let uid: String
    let name: String
    let isDefault: Bool
}

private func property<T>(_ object: AudioObjectID, _ selector: AudioObjectPropertySelector,
                         scope: AudioObjectPropertyScope = kAudioObjectPropertyScopeGlobal,
                         _ initial: T) -> T? {
    var address = AudioObjectPropertyAddress(mSelector: selector, mScope: scope, mElement: kAudioObjectPropertyElementMain)
    var value = initial
    var size = UInt32(MemoryLayout<T>.size)
    let status = withUnsafeMutablePointer(to: &value) {
        AudioObjectGetPropertyData(object, &address, 0, nil, &size, $0)
    }
    return status == noErr ? value : nil
}

private func stringProperty(_ object: AudioObjectID, _ selector: AudioObjectPropertySelector) -> String? {
    var address = AudioObjectPropertyAddress(mSelector: selector, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
    var value: Unmanaged<CFString>?
    var size = UInt32(MemoryLayout<Unmanaged<CFString>?>.size)
    let status = AudioObjectGetPropertyData(object, &address, 0, nil, &size, &value)
    guard status == noErr, let value else { return nil }
    return value.takeRetainedValue() as String
}

private func inputChannelCount(_ device: AudioDeviceID) -> Int {
    var address = AudioObjectPropertyAddress(mSelector: kAudioDevicePropertyStreamConfiguration,
                                             mScope: kAudioDevicePropertyScopeInput,
                                             mElement: kAudioObjectPropertyElementMain)
    var size: UInt32 = 0
    guard AudioObjectGetPropertyDataSize(device, &address, 0, nil, &size) == noErr, size > 0 else { return 0 }
    let raw = UnsafeMutableRawPointer.allocate(byteCount: Int(size), alignment: MemoryLayout<AudioBufferList>.alignment)
    defer { raw.deallocate() }
    guard AudioObjectGetPropertyData(device, &address, 0, nil, &size, raw) == noErr else { return 0 }
    let list = UnsafeMutableAudioBufferListPointer(raw.assumingMemoryBound(to: AudioBufferList.self))
    return list.reduce(0) { $0 + Int($1.mNumberChannels) }
}

func listInputDevices() -> [InputDevice] {
    let system = AudioObjectID(kAudioObjectSystemObject)
    var address = AudioObjectPropertyAddress(mSelector: kAudioHardwarePropertyDevices,
                                             mScope: kAudioObjectPropertyScopeGlobal,
                                             mElement: kAudioObjectPropertyElementMain)
    var size: UInt32 = 0
    guard AudioObjectGetPropertyDataSize(system, &address, 0, nil, &size) == noErr else { return [] }
    var ids = [AudioDeviceID](repeating: 0, count: Int(size) / MemoryLayout<AudioDeviceID>.size)
    guard AudioObjectGetPropertyData(system, &address, 0, nil, &size, &ids) == noErr else { return [] }
    let defaultID = property(system, kAudioHardwarePropertyDefaultInputDevice, AudioDeviceID(0)) ?? 0
    return ids.compactMap { id in
        guard inputChannelCount(id) > 0 else { return nil }
        return InputDevice(id: id,
                           uid: stringProperty(id, kAudioDevicePropertyDeviceUID) ?? "",
                           name: stringProperty(id, kAudioObjectPropertyName) ?? "",
                           isDefault: id == defaultID)
    }
}

/// Finds an input device by exact UID, exact name, or case-insensitive name prefix.
func findInputDevice(_ query: String) -> InputDevice? {
    let devices = listInputDevices()
    if let d = devices.first(where: { $0.uid == query || $0.name == query }) { return d }
    let lower = query.lowercased()
    return devices.first(where: { $0.name.lowercased().hasPrefix(lower) })
}
