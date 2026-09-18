//! Asking an OpenAI-compatible endpoint — the reader's URL, the reader's key,
//! the reader's choice of model.
//!
//! WI-15.8's half that did not exist until 2026-09-18. The endpoints the reader
//! stored used to reach a provider through Lemonade (`POST /v1/install`, the key
//! in its environment); that path was never measured working, and it went with
//! lemond. This is Paper's own client instead, and it is small because the
//! protocol is the one the local server already speaks: `POST
//! {base_url}/chat/completions`, streamed, read by `generate::stream`.
//!
//! # What differs from the local server, and nothing else does
//!
//! - **The address and the key are the reader's.** The key is read from the
//!   keychain here, in Rust, for the one request — the webview never holds it,
//!   for the reason every other key in this crate stays in Rust.
//! - **The model is the provider's name for it** (`Endpoint::model`), never a
//!   manifest id.
//! - **A remote endpoint takes the reader's system proxy**; a loopback one
//!   (`http://localhost…`, Ollama or LM Studio) never does. See
//!   `daemon::endpoint_client`.
//! - **Failures are the endpoint's, by name** — `EndpointHttp`,
//!   `EndpointUnreachable` — not the local runtime's: "check the key or the
//!   address" is different advice from "the runtime did not start".
//!
//! # A provider that refuses the schema
//!
//! `response_format` with a JSON schema is not universal. A provider that does
//! not implement it answers **400**, and the lookup is then asked ONCE MORE
//! without it: the answer arrives as prose, which `definitionOf` draws whole —
//! a definition with no part of speech, not a failure. Only a 400 earns the
//! retry, and only one; anything else is the endpoint's answer, reported.
//!
//! ⚠️ **NOT MEASURED AGAINST A PAID PROVIDER YET.** The client is driven against
//! the local `llama-server`, which speaks the same protocol with a key
//! (`live_endpoint_…` in `commands.rs`). A provider's own quirks — a reasoning
//! model that rejects `max_tokens` or `temperature`, a structured-output mode
//! that rejects a keyword — are exactly what that measurement has not seen.

use crate::daemon::{endpoint_client, ModelRequest};
use crate::endpoints::Endpoint;
use crate::error::{Error, Result};
use crate::generate::{self, Answer, ChatRequest};
use crate::requests::Cancel;

/// The route appended to an endpoint's base URL — the OpenAI one. A base URL
/// is written WITH its version (`https://api.openai.com/v1`,
/// `http://localhost:11434/v1`), which is how every provider documents it.
pub const CHAT_PATH: &str = "/chat/completions";

/// The two clients an endpoint request can go through, built once.
pub struct Clients {
    remote: reqwest::Client,
    loopback: reqwest::Client,
}

impl Clients {
    pub fn new() -> Result<Clients> {
        Ok(Clients {
            remote: endpoint_client(true)?,
            loopback: endpoint_client(false)?,
        })
    }

    fn for_url(&self, base_url: &str) -> &reqwest::Client {
        if base_url.starts_with("http://") {
            /* `valid_base_url` admits `http://` ONLY to a loopback host, so
            this is the loopback client by construction — and a proxy never
            sees a request for this machine. */
            &self.loopback
        } else {
            &self.remote
        }
    }
}

/// The URL a request goes to: the base, without a trailing slash, and the path.
pub fn chat_url(base_url: &str) -> String {
    format!("{}{CHAT_PATH}", base_url.trim_end_matches('/'))
}

/// Ask `endpoint` for `body`, with the schema; once more without it if the
/// provider refuses the schema with a 400. See the module header.
///
/// `on_text` receives the answer as it streams — the companion watches it
/// arrive; a gloss passes a no-op and reads the whole answer. `key` is `None`
/// for a loopback endpoint stored without one (see `probe::endpoint_route`).
pub async fn ask(
    clients: &Clients,
    endpoint: &Endpoint,
    key: Option<&str>,
    body: ChatRequest,
    ceiling: std::time::Duration,
    cancel: &Cancel,
    mut on_text: impl FnMut(String),
) -> Result<Answer> {
    match once(clients, endpoint, key, &body, ceiling, cancel, &mut on_text).await {
        Err(Error::EndpointHttp { status: 400, .. }) if body.response_format.is_some() => {
            log::warn!(
                "inference: endpoint {} refused the answer's schema (400); asking without it",
                endpoint.id
            );
            let plain = ChatRequest {
                response_format: None,
                ..body
            };
            once(
                clients,
                endpoint,
                key,
                &plain,
                ceiling,
                cancel,
                &mut on_text,
            )
            .await
        }
        answered => answered,
    }
}

async fn once(
    clients: &Clients,
    endpoint: &Endpoint,
    key: Option<&str>,
    body: &ChatRequest,
    ceiling: std::time::Duration,
    cancel: &Cancel,
    on_text: &mut impl FnMut(String),
) -> Result<Answer> {
    let request = ModelRequest::to_endpoint(
        clients.for_url(&endpoint.base_url),
        chat_url(&endpoint.base_url),
        key,
    )
    .deadline(ceiling)
    .json(body);
    generate::stream(request, cancel, on_text)
        .await
        .map_err(|failure| as_endpoints(failure, &endpoint.id))
}

/// `generate::stream` names its failures for the local runtime; an endpoint's
/// are the endpoint's. Everything that is not about reaching or being answered
/// by it — a cancellation, an answer too large, a malformed stream — passes
/// through unchanged.
fn as_endpoints(failure: Error, endpoint: &str) -> Error {
    match failure {
        Error::RuntimeHttp { status, .. } => Error::EndpointHttp {
            endpoint: endpoint.to_owned(),
            status,
        },
        Error::RuntimeUnreachable { message, .. } => Error::EndpointUnreachable {
            endpoint: endpoint.to_owned(),
            message,
        },
        other => other,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_chat_path_is_appended_once_whatever_the_base_ends_with() {
        assert_eq!(
            chat_url("https://api.openai.com/v1"),
            "https://api.openai.com/v1/chat/completions"
        );
        assert_eq!(
            chat_url("http://localhost:11434/v1/"),
            "http://localhost:11434/v1/chat/completions"
        );
    }

    /// A failure is the ENDPOINT'S, named by the id the reader chose — the
    /// advice differs from the local runtime's — and anything that is not about
    /// reaching it keeps its own kind.
    #[test]
    fn a_failure_is_named_for_the_endpoint_and_nothing_else_is_renamed() {
        let http = as_endpoints(
            Error::RuntimeHttp {
                status: 401,
                route: CHAT_PATH.to_owned(),
            },
            "proxy",
        );
        assert_eq!(http.kind(), "endpointHttp");
        assert_eq!(http.to_string(), "the endpoint proxy answered 401");

        let unreachable = as_endpoints(
            Error::RuntimeUnreachable {
                route: CHAT_PATH.to_owned(),
                message: "dns error".to_owned(),
            },
            "proxy",
        );
        assert_eq!(unreachable.kind(), "endpointUnreachable");

        assert_eq!(as_endpoints(Error::Cancelled, "proxy").kind(), "cancelled");
    }

    /// The retry exists for ONE refusal: a 400 to a request that carried the
    /// schema. Driven against a server that answers 400 to anything carrying
    /// `response_format` and a clean stream to anything without it — so the
    /// second request is proved to go out WITHOUT the schema, not merely to go
    /// out.
    #[tokio::test]
    async fn a_provider_that_refuses_the_schema_is_asked_once_more_without_it() {
        use std::io::{Read, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let bodies = std::sync::Arc::new(std::sync::Mutex::new(Vec::<String>::new()));
        let seen = std::sync::Arc::clone(&bodies);
        std::thread::spawn(move || {
            for stream in listener.incoming().take(2) {
                let mut stream = stream.unwrap();
                let mut raw = Vec::new();
                let mut chunk = [0u8; 4096];
                /* Read until the body is complete: the header says how long. */
                loop {
                    let n = stream.read(&mut chunk).unwrap();
                    raw.extend_from_slice(&chunk[..n]);
                    let text = String::from_utf8_lossy(&raw).into_owned();
                    if let Some(split) = text.find("\r\n\r\n") {
                        let length = text[..split]
                            .lines()
                            .find_map(|line| {
                                line.to_ascii_lowercase()
                                    .strip_prefix("content-length:")
                                    .map(|n| n.trim().parse::<usize>().unwrap())
                            })
                            .unwrap_or(0);
                        if raw.len() >= split + 4 + length {
                            break;
                        }
                    }
                }
                let text = String::from_utf8_lossy(&raw).into_owned();
                let body = text[text.find("\r\n\r\n").unwrap() + 4..].to_owned();
                let refuse = body.contains("response_format");
                seen.lock().unwrap().push(body);
                let reply = if refuse {
                    "HTTP/1.1 400 Bad Request\r\ncontent-length: 0\r\nconnection: close\r\n\r\n"
                        .to_owned()
                } else {
                    let sse = "data: {\"choices\":[{\"delta\":{\"content\":\"A meaning.\"}}]}\n\ndata: {\"choices\":[{\"delta\":{},\"finish_reason\":\"stop\"}]}\n\ndata: [DONE]\n\n";
                    format!(
                        "HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{sse}",
                        sse.len()
                    )
                };
                stream.write_all(reply.as_bytes()).unwrap();
            }
        });
        let endpoint = Endpoint {
            id: "local".to_owned(),
            label: "L".to_owned(),
            base_url: format!("http://{address}/v1"),
            model: "m".to_owned(),
            key_state: crate::endpoints::KeyState::Set,
        };
        let body = ChatRequest {
            model: "m".to_owned(),
            messages: Vec::new(),
            max_tokens: 8,
            temperature: 0.2,
            stream: true,
            response_format: Some(crate::gloss::response_format("English", None)),
        };
        let registry = crate::requests::Registry::default();
        let guard = registry.begin("cloud-test").unwrap();
        let answer = ask(
            &Clients::new().unwrap(),
            &endpoint,
            Some("k"),
            body,
            std::time::Duration::from_secs(20),
            &guard.cancel(),
            |_| {},
        )
        .await
        .expect("the second request is answered");
        assert_eq!(answer.text, "A meaning.");
        let bodies = bodies.lock().unwrap();
        assert_eq!(bodies.len(), 2, "one refusal, one retry, and no more");
        assert!(bodies[0].contains("response_format"));
        assert!(!bodies[1].contains("response_format"), "{}", bodies[1]);
    }

    /// ⚠️ **A LOOPBACK ENDPOINT WITH NO KEY SENDS NO `Authorization` AT ALL** —
    /// not `Bearer ` with nothing after it, which some servers read as a
    /// malformed credential and refuse. Read off the raw request a real client
    /// wrote, and the keyed request beside it carries its key.
    #[tokio::test]
    async fn a_keyless_request_carries_no_authorization_header() {
        use std::io::{Read, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let heads = std::sync::Arc::new(std::sync::Mutex::new(Vec::<String>::new()));
        let seen = std::sync::Arc::clone(&heads);
        std::thread::spawn(move || {
            for stream in listener.incoming().take(2) {
                let mut stream = stream.unwrap();
                let mut raw = Vec::new();
                let mut chunk = [0u8; 4096];
                while !String::from_utf8_lossy(&raw).contains("\r\n\r\n") {
                    let n = stream.read(&mut chunk).unwrap();
                    raw.extend_from_slice(&chunk[..n]);
                }
                let text = String::from_utf8_lossy(&raw).into_owned();
                seen.lock()
                    .unwrap()
                    .push(text[..text.find("\r\n\r\n").unwrap()].to_ascii_lowercase());
                let sse = "data: {\"choices\":[{\"delta\":{\"content\":\"ok\"},\"finish_reason\":\"stop\"}]}\n\ndata: [DONE]\n\n";
                let reply = format!(
                    "HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{sse}",
                    sse.len()
                );
                stream.write_all(reply.as_bytes()).unwrap();
            }
        });
        let endpoint = Endpoint {
            id: "ollama".to_owned(),
            label: "Ollama".to_owned(),
            base_url: format!("http://{address}/v1"),
            model: "m".to_owned(),
            key_state: crate::endpoints::KeyState::Missing,
        };
        let body = || ChatRequest {
            model: "m".to_owned(),
            messages: Vec::new(),
            max_tokens: 8,
            temperature: 0.2,
            stream: true,
            response_format: None,
        };
        let clients = Clients::new().unwrap();
        let registry = crate::requests::Registry::default();
        for key in [None, Some("sk-test")] {
            let guard = registry.begin("keyless").unwrap();
            ask(
                &clients,
                &endpoint,
                key,
                body(),
                std::time::Duration::from_secs(20),
                &guard.cancel(),
                |_| {},
            )
            .await
            .expect("the endpoint answered");
        }
        let heads = heads.lock().unwrap();
        assert!(!heads[0].contains("authorization:"), "{}", heads[0]);
        assert!(
            heads[1].contains("authorization: bearer sk-test"),
            "{}",
            heads[1]
        );
    }
}
