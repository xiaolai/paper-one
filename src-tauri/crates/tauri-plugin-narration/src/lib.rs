//! Paper's audiobook export: a book's chapters, rendered by the voices plugin,
//! joined, encoded and muxed into one M4B with a chapter mark per section.
//!
//! # The boundary
//!
//! ```text
//! window ──narration_pick──▶ save dialog (here) ──▶ token
//! window ──narration_begin─▶ run directory under <data>/audiobook/
//! window ──voices_render_file(<run>/chapter-N.wav)──▶ voices plugin
//! window ──narrate_package(run, token, chapters)──▶ join ▶ afconvert ▶ mux ▶ rename
//! ```
//!
//! The window never holds a destination path and never names a file this
//! plugin opens as given; `commands` says how, and
//! `dev-docs/decisions/2026-11-09-narration-boundary.md` says why.
//!
//! Moved out of the app crate's `narrate` module on 2026-11-09.

pub mod commands;
pub mod destination;
pub mod inputs;
pub mod limits;
pub mod narrate;
pub mod plugin;
pub mod scratch;
pub mod staged;

pub use plugin::init;
