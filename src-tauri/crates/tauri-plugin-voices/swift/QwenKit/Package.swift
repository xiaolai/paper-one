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
        // ⚠️ **A REVISION, NOT `branch: "main"` — AND THE FLOOR IS WHAT MOVES.**
        // This read `branch: "main"` until 2026-09-29. `Package.resolved` is
        // tracked, so every build so far has been reproducible; what a branch
        // gives up is the UPPER BOUND. Any resolution — a `swift package
        // update`, a manifest edit that changes `originHash`, a checkout with no
        // resolved file — silently takes whatever is on `main` at that moment,
        // and nothing reviews it.
        //
        // What that moves is not this package. `mlx-audio-swift` declares
        // `swift-tools-version: 6.2`; its own `mlx-swift` @ 0.31.6 declares
        // **6.3**, and 6.3 is the number `verify.yml` asserts a runner's Xcode
        // against. So this line decides which mlx-swift range is requested,
        // which decides the Swift version every machine and runner must have.
        // The tip happened to equal the pin when this was written (upstream's
        // last commit to `main` was 2026-09-18, and the pin was taken
        // 2026-09-23), so nothing had drifted yet — this is the bound, taken
        // before it does.
        //
        // Moving it is now an edit somebody reads: bump the revision, run
        // `swift package resolve`, and check what came with it.
        // `scripts/no-floating-swift-pins.test.mjs` refuses a branch here.
        .package(url: "https://github.com/Blaizzy/mlx-audio-swift.git", revision: "01dec7c9bdce3088a6b6b7ab9f2e403458195efb"),
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
