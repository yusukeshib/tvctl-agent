// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "tvctl-voice",
    platforms: [.macOS("26.0")],
    targets: [
        .executableTarget(
            name: "tvctl-voice",
            path: "Sources/tvctl-voice",
            swiftSettings: [.swiftLanguageMode(.v5)]
        )
    ]
)
