// swift-tools-version: 6.0
//
// The Swift half of the Qwen engine, built as a STATIC library so `swift-rs`
// can link it into the Rust binary. Building this needs Xcode's Metal
// Toolchain component on every machine and CI runner that compiles it:
//
//     xcodebuild -downloadComponent MetalToolchain
//
// Without it the build fails at "CompileMetalFile ... failed", which reads like
// a problem with the source and is a missing 839 MB download.
import PackageDescription

let package = Package(
    name: "QwenKit",
    platforms: [.macOS(.v14)],
    products: [.library(name: "QwenKit", type: .static, targets: ["QwenKit"])],
    dependencies: [
        .package(url: "https://github.com/Blaizzy/mlx-audio-swift.git", branch: "main"),
    ],
    targets: [
        .target(
            name: "QwenKit",
            dependencies: [
                .product(name: "MLXAudioTTS", package: "mlx-audio-swift"),
                .product(name: "MLXAudioCore", package: "mlx-audio-swift"),
            ]
        )
    ]
)
