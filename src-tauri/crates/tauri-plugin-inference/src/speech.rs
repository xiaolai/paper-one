//! Speech synthesis over the daemon's audio route (WI-15.9).
//!
//! # Why this is not in `commands.rs`
//!
//! That module states its own design in its header: the commands are thin
//! façades over policy that lives elsewhere. `inference_speak` was the one
//! that was not — request construction, cancellation orchestration, HTTP
//! status handling, body collection and three separate error mappings, inline
//! among a list of one-line delegations. A module that says what it is and
//! then holds one exception is a module whose rule nobody can rely on.
//!
//! # The route, and its one surprise
//!
//! `/api/v1/audio/generations`, and its field is **`prompt`**, not OpenAI's
//! `input` — verified against 11.7.0, which answers `Missing 'prompt' field in
//! request` for the OpenAI spelling. `/api/v1/audio/speech` does not answer at
//! all. That asymmetry stays behind this function rather than being something
//! a caller has to know.

use crate::error::{unreachable, Error, Result};
use crate::requests::Cancel;

/// The daemon's speech route.
///
/// A constant because it was written out four times — in the request and in
/// three error paths — so a route change could leave the diagnostics naming a
/// path the request never used.
pub const SPEECH_ROUTE: &str = "/api/v1/audio/generations";

/// The body the daemon expects. `voice` is omitted when the caller has none.
pub fn body(model: &str, text: &str, voice: Option<&str>) -> serde_json::Value {
    let mut body = serde_json::json!({ "model": model, "prompt": text });
    if let Some(voice) = voice {
        body["voice"] = serde_json::Value::String(voice.to_owned());
    }
    body
}

/// Send `request` and collect the audio, racing cancellation at every await.
///
/// ⚠️ **BOTH AWAITS RACE IT.** Cancelling mid-utterance has to stop the
/// REQUEST as well as the audio — WI-15.9's acceptance names both — and a
/// response whose body is still arriving is a request still being served.
pub async fn collect(request: reqwest::RequestBuilder, cancel: &Cancel) -> Result<Vec<u8>> {
    let response = tokio::select! {
        biased;
        () = cancel.cancelled() => return Err(Error::Cancelled),
        sent = request.send() => sent.map_err(|e| unreachable(SPEECH_ROUTE, e))?,
    };
    let status = response.status();
    if !status.is_success() {
        return Err(Error::RuntimeHttp {
            status: status.as_u16(),
            route: SPEECH_ROUTE.to_owned(),
        });
    }
    let bytes = tokio::select! {
        biased;
        () = cancel.cancelled() => return Err(Error::Cancelled),
        body = response.bytes() => body.map_err(|e| unreachable(SPEECH_ROUTE, e))?,
    };
    Ok(bytes.to_vec())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// ⚠️ `prompt`, NOT `input`. The daemon answers `Missing 'prompt' field in
    /// request` for the OpenAI spelling, and that is a runtime failure with
    /// nothing in the type system to catch it — so it is pinned here.
    #[test]
    fn the_body_names_the_field_the_daemon_actually_wants() {
        let sent = body("kokoro", "hello", None);
        assert_eq!(sent["prompt"], "hello");
        assert!(
            sent.get("input").is_none(),
            "the OpenAI spelling would be refused"
        );
        assert_eq!(sent["model"], "kokoro");
    }

    /// An absent voice is OMITTED rather than sent as null: the daemon picks
    /// its own default, and a null would be a value it has to interpret.
    #[test]
    fn an_absent_voice_is_left_out() {
        assert!(body("kokoro", "hello", None).get("voice").is_none());
        assert_eq!(body("kokoro", "hello", Some("af_sky"))["voice"], "af_sky");
    }

    #[test]
    fn the_route_is_the_one_that_answers() {
        // `/api/v1/audio/speech` does not answer at all — see the header.
        assert_eq!(SPEECH_ROUTE, "/api/v1/audio/generations");
    }

    /// Cancelled before the request is even sent, which is the case a reader
    /// pressing Stop the moment they press Play produces.
    #[tokio::test]
    async fn a_cancelled_request_is_never_sent() {
        let registry = crate::requests::Registry::default();
        let guard = registry.begin("voice").expect("a fresh request");
        let cancel = guard.cancel();
        cancel.trip();

        /* An address nothing is listening on: reaching the network at all
        would be the failure, and this makes that failure distinguishable
        from the cancellation. */
        let request = reqwest::Client::new().post("http://127.0.0.1:1/api/v1/audio/generations");
        assert!(matches!(
            collect(request, &cancel).await,
            Err(Error::Cancelled)
        ));
    }
}
