// The C ABI the Rust side calls. Three entry points and no more: load a pack,
// render one sentence, let the model go.
//
// Everything that decides anything lives in Rust — how long a sentence should
// take, whether what came back is believable, when to try another seed. This
// file is the thinnest possible bridge to MLX, because it is the part that
// cannot be tested on a machine without the model, and nothing untested should
// be deciding anything.
//
// Three things here were learned the hard way in the phase-30 spike and are
// requirements rather than style:
//
//   - `mlx-swift_Cmlx.bundle` must sit beside the executable, or MLX cannot
//     find its Metal shaders and dies at run time with "Failed to load the
//     default metallib". It is a Tauri resource for that reason.
//   - Swift 6 refuses a `Task` that captures a mutable local, which is what a
//     synchronous C function needs in order to wait for an async answer. The
//     box below is the way through: exactly one writer, and the reader does not
//     run until the semaphore is signalled.
//   - `TTS.loadModel` takes a local directory when the path holds a
//     `config.json`, so a render never reaches the network. The installer has
//     already checked every byte against the manifest; re-fetching would be a
//     second, unverified copy.

import Foundation
// `MLXRandom` is a namespace INSIDE the MLX module; the module of that name is
// a legacy shim, so importing it separately is both unnecessary and a
// transitive dependency this package does not declare.
import MLX
import MLXAudioCore
import MLXAudioTTS
import MLXLMCommon

/// What a negative answer means. Rust reads these by name; keep them in step
/// with `Failure` in `qwen/engine.rs`.
private enum Failure: Int64 {
    case notLoaded = -1
    case badArgument = -2
    case generationFailed = -3
    /// The model produced more audio than the cap allowed room for. This is the
    /// runaway arriving, not a bug: it is reported so the engine can re-seed or
    /// refuse, rather than silently writing the first part of a babble.
    case overflowed = -4
    case noAudio = -5
}

/// Somewhere for the detached task to put its answer.
///
/// `@unchecked Sendable` is a promise the semaphore keeps: the task writes
/// before it signals, the caller reads after it waits, so the two never touch
/// the box at the same time.
private final class Answer<T>: @unchecked Sendable {
    var value: T
    init(_ value: T) { self.value = value }
}

/// A value carried INTO the task, for the same reason and with the same
/// promise.
///
/// Swift 6 refuses a `@Sendable` closure that captures the loaded model (a
/// class nobody declared `Sendable`) or the caller's buffer (a raw pointer,
/// which is `Sendable` for nobody). Both are genuinely safe here and the
/// mechanism is the semaphore again, not optimism: the caller is BLOCKED for
/// the whole of the task's life, so there is exactly one thread touching
/// either at any moment. This is the narrowest way to say that; the
/// alternative is making the C entry points async, which they cannot be.
private final class Carried<T>: @unchecked Sendable {
    let value: T
    init(_ value: T) { self.value = value }
}

/// The loaded model, and the only mutable state in this file.
///
/// A class rather than a global `var` so that `unload` genuinely drops the last
/// reference: the reader's memory is the whole reason this call exists, and a
/// model that is merely unreachable rather than released still holds its 2.5 GB.
private final class Held: @unchecked Sendable {
    static let shared = Held()
    private let lock = NSLock()
    private var model: SpeechGenerationModel?

    func put(_ model: SpeechGenerationModel?) {
        lock.lock()
        defer { lock.unlock() }
        self.model = model
    }

    func get() -> SpeechGenerationModel? {
        lock.lock()
        defer { lock.unlock() }
        return model
    }
}

/// Run an async piece of work and wait for it, which is what a C entry point
/// must do. The semaphore is what makes the box safe.
private func waitFor<T>(_ initial: T, _ work: @escaping @Sendable () async -> T) -> T {
    let answer = Answer(initial)
    let done = DispatchSemaphore(value: 0)
    Task.detached {
        let result = await work()
        answer.value = result
        done.signal()
    }
    done.wait()
    return answer.value
}

/// Say what went wrong where a person can find it. A release build has no
/// stdout, so this is for the developer at a terminal; the reader is told by
/// the Rust side, which turns a code into a sentence.
private func complain(_ what: String) {
    FileHandle.standardError.write("QwenKit: \(what)\n".data(using: .utf8)!)
}

/// Load a pack. Answers the model's sample rate, or a negative `Failure`.
@_cdecl("paper_qwen_load")
public func paperQwenLoad(directory: UnsafePointer<CChar>) -> Int64 {
    let path = String(cString: directory)
    if path.isEmpty {
        return Failure.badArgument.rawValue
    }
    // ⚠️ A PATH THAT IS NOT AN INSTALLED PACK MUST NOT REACH `TTS.loadModel`.
    // It takes a local directory only when the directory exists AND holds a
    // `config.json`; ANY OTHER STRING IT TREATS AS A HUGGING FACE REPOSITORY
    // ID AND DOWNLOADS. Measured 2026-09-23 by the linkage test, which passes a
    // deliberately absent path and made the suite print "Downloading model
    // nonexistent/paper-voices-pack". In the app that is worse than a slow
    // test: the installer is the only thing that may fetch, because it is the
    // only thing that checks what it fetched against the manifest.
    var isDirectory: ObjCBool = false
    let hasDirectory = FileManager.default.fileExists(atPath: path, isDirectory: &isDirectory)
    let config = URL(fileURLWithPath: path).appendingPathComponent("config.json").path
    guard hasDirectory, isDirectory.boolValue, FileManager.default.fileExists(atPath: config) else {
        complain("\(path) is not an installed pack — refusing rather than fetching one")
        return Failure.badArgument.rawValue
    }
    return waitFor(Failure.generationFailed.rawValue) {
        do {
            let model = try await TTS.loadModel(modelRepo: path)
            Held.shared.put(model)
            return Int64(model.sampleRate)
        } catch {
            complain("could not load \(path): \(error)")
            return Failure.generationFailed.rawValue
        }
    }
}

/// Render one sentence into the caller's buffer.
///
/// The buffer is the caller's because its size is already known: Rust derives
/// it from the same frame cap it passes as `maxFrames`, so no allocation
/// crosses this boundary and there is no fourth call to free anything.
///
/// Answers how many samples were written, or a negative `Failure`.
@_cdecl("paper_qwen_render")
public func paperQwenRender(
    text: UnsafePointer<CChar>,
    voice: UnsafePointer<CChar>,
    language: UnsafePointer<CChar>,
    maxFrames: Int64,
    seed: UInt64,
    out: UnsafeMutablePointer<Float>,
    capacity: Int64
) -> Int64 {
    let textS = String(cString: text)
    let voiceS = String(cString: voice)
    let languageS = String(cString: language)
    if textS.isEmpty || maxFrames <= 0 || capacity <= 0 {
        return Failure.badArgument.rawValue
    }
    guard let model = Held.shared.get() else {
        return Failure.notLoaded.rawValue
    }
    let carriedModel = Carried(model)
    let carriedBuffer = Carried(UnsafeMutableBufferPointer(start: out, count: Int(capacity)))
    return waitFor(Failure.generationFailed.rawValue) {
        let model = carriedModel.value
        let buffer = carriedBuffer.value
        do {
            // ⚠️ THE MODEL'S OWN PARAMETERS, WITH TWO FIELDS CHANGED — never a
            // fresh `GenerateParameters`. Qwen3TTS asks for temperature 0.9,
            // topP 1.0 and a repetition penalty of 1.05; constructing the
            // struct instead takes ITS defaults (0.6, 0.8, none), which is
            // quietly sampling a tuned model wrongly. Measured: it read
            // "2025年" as 2015 and "128本" as 1280 — number errors, the place a
            // reader notices first — and the same passage through the model's
            // own settings had none.
            var parameters = model.defaultGenerationParameters
            parameters.maxTokens = Int(maxFrames)
            // ⚠️ THE GLOBAL SEED IS THE ONE THIS MODEL OBEYS, AND SETTING
            // `parameters.seed` ALONE DOES NOTHING. Qwen3TTS samples with
            // `categorical(...)`, which draws from MLX's process-wide PRNG and
            // never reads the parameter. Measured: with only the field set, the
            // same text and seed rendered 10.32 s and then 10.56 s, with
            // different bytes. Both are set — the field for any path that comes
            // to honour it, the global because it is what works today.
            parameters.seed = seed
            MLXRandom.seed(seed)
            let audio = try await model.generate(
                text: textS,
                voice: voiceS.isEmpty ? nil : voiceS,
                refAudio: nil,
                refText: nil,
                language: languageS.isEmpty ? nil : languageS,
                generationParameters: parameters
            )
            let samples = audio.asArray(Float.self)
            if samples.isEmpty {
                return Failure.noAudio.rawValue
            }
            // Refusing rather than truncating: a buffer's worth of a runaway is
            // indistinguishable from a sentence that fitted exactly.
            if samples.count > buffer.count {
                return Failure.overflowed.rawValue
            }
            _ = buffer.update(fromContentsOf: samples)
            return Int64(samples.count)
        } catch {
            complain("could not render \(textS.prefix(40)): \(error)")
            return Failure.generationFailed.rawValue
        }
    }
}

/// Let the model go, and its memory with it.
@_cdecl("paper_qwen_unload")
public func paperQwenUnload() {
    Held.shared.put(nil)
    // MLX keeps freed blocks in its own pool, so dropping the model is not
    // enough on its own: without this the resident size stays where it was and
    // "unloaded" is a claim nobody can measure.
    MLX.Memory.clearCache()
}
