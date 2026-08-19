//! What the plugin tells the webview unprompted, and how.
//!
//! Every event has a fixed name (`peer://…`) and a camelCase JSON payload.
//! The plugin core never sees Tauri: it calls an [`EventSink`], which the
//! Tauri layer implements with `app.emit(name, payload)` and tests implement
//! with a channel.

use std::sync::Arc;

use serde::Serialize;

use crate::role::Role;

/// Where events go. Cheap to clone; called from any task.
pub type EventSink = Arc<dyn Fn(PeerEvent) + Send + Sync>;

/// A sink that drops everything — the default when nothing listens.
pub fn null_sink() -> EventSink {
    Arc::new(|_| {})
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PairingPending {
    /// An unguessable id for this exact pairing attempt. The webview echoes it
    /// back to `peer_pair_confirm`, so a stale confirm — or a pre-played QR
    /// that produced a different attempt — cannot confirm this one.
    pub attempt_id: String,
    pub id: String,
    pub name: String,
    pub platform: String,
    /// Six decimal digits, zero-padded, identical on the satchel's screen.
    pub sas: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PairingResult {
    pub ok: bool,
    /// The peer that was (or would have been) persisted.
    pub id: String,
    pub name: Option<String>,
    pub platform: Option<String>,
    pub role: Option<Role>,
    /// Set when `ok` is false: `refused`, `bad-mac`, `expired`, `timeout`, …
    pub reason: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SessionOpen {
    pub session_id: u64,
    pub peer_id: String,
    /// The remote's role.
    pub role: Role,
    /// True when this side dialed.
    pub initiator: bool,
    /// The remote's plugin hello (on the accepting side) or ours (on the
    /// dialing side), verbatim.
    pub hello: serde_json::Value,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SessionClosed {
    pub session_id: u64,
    /// `closed`, `revoked`, `frame-too-large`, `lost`, or the reason the
    /// remote gave.
    pub reason: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SessionFrames {
    pub session_id: u64,
    /// Frames waiting in the inbox after this arrival.
    pub count: usize,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum TransferState {
    Running,
    Done,
    Failed,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TransferProgress {
    pub transfer_id: u64,
    pub received: u64,
    pub total: u64,
    pub state: TransferState,
    /// The error kind when `state` is `failed`.
    pub error: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PeerEvent {
    PairingPending(PairingPending),
    PairingResult(PairingResult),
    SessionOpen(SessionOpen),
    SessionClosed(SessionClosed),
    SessionFrames(SessionFrames),
    Transfer(TransferProgress),
}

impl PeerEvent {
    /// The Tauri event name.
    pub fn name(&self) -> &'static str {
        match self {
            PeerEvent::PairingPending(_) => "peer://pairing-pending",
            PeerEvent::PairingResult(_) => "peer://pairing-result",
            PeerEvent::SessionOpen(_) => "peer://session-open",
            PeerEvent::SessionClosed(_) => "peer://session-closed",
            PeerEvent::SessionFrames(_) => "peer://session-frames",
            PeerEvent::Transfer(_) => "peer://transfer",
        }
    }

    /// The JSON payload.
    pub fn payload(&self) -> serde_json::Value {
        let value = match self {
            PeerEvent::PairingPending(p) => serde_json::to_value(p),
            PeerEvent::PairingResult(p) => serde_json::to_value(p),
            PeerEvent::SessionOpen(p) => serde_json::to_value(p),
            PeerEvent::SessionClosed(p) => serde_json::to_value(p),
            PeerEvent::SessionFrames(p) => serde_json::to_value(p),
            PeerEvent::Transfer(p) => serde_json::to_value(p),
        };
        value.expect("event payloads serialize")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_are_valid_tauri_event_names_and_payloads_are_camel_case() {
        // EVERY variant — the test's claim is the whole event surface, and a
        // variant left out is a payload whose casing nothing checks.
        let events = [
            PeerEvent::PairingPending(PairingPending {
                attempt_id: "att-1".into(),
                id: "a".into(),
                name: "n".into(),
                platform: "macos".into(),
                sas: "000042".into(),
            }),
            PeerEvent::PairingResult(PairingResult {
                ok: false,
                id: "a".into(),
                name: None,
                platform: None,
                role: None,
                reason: Some("bad-mac".into()),
            }),
            PeerEvent::SessionOpen(SessionOpen {
                session_id: 3,
                peer_id: "a".into(),
                role: Role::Shelf,
                initiator: true,
                hello: serde_json::Value::Null,
            }),
            PeerEvent::SessionClosed(SessionClosed {
                session_id: 3,
                reason: "closed".into(),
            }),
            PeerEvent::SessionFrames(SessionFrames {
                session_id: 3,
                count: 2,
            }),
            PeerEvent::Transfer(TransferProgress {
                transfer_id: 1,
                received: 5,
                total: 10,
                state: TransferState::Running,
                error: None,
            }),
        ];
        for event in &events {
            let name = event.name();
            assert!(name.starts_with("peer://"));
            assert!(name
                .chars()
                .all(|c| c.is_alphanumeric() || matches!(c, '-' | '/' | ':' | '_')));
        }
        // The renamed (snake→camel) field of each payload type that has one.
        assert_eq!(events[0].payload()["attemptId"], "att-1");
        assert_eq!(events[1].payload()["reason"], "bad-mac");
        assert_eq!(events[2].payload()["peerId"], "a");
        assert_eq!(events[3].payload()["sessionId"], 3);
        assert_eq!(events[4].payload()["sessionId"], 3);
        assert_eq!(events[4].payload()["count"], 2);
        assert_eq!(events[5].payload()["transferId"], 1);
        assert_eq!(events[5].payload()["state"], "running");
    }
}
