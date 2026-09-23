//! Paper's downloadable voices.
//!
//! A reader who wants a book read aloud on a Mac downloads a pack: a model, its
//! voices, and whatever the engine needs to turn text into sounds. Nothing here
//! ships inside the app bundle but code — see `manifest` for what a pack is and
//! why the catalogue is embedded rather than fetched, and `install` for what
//! makes a stopped download leave nothing half-installed.

pub mod cancel;
pub mod digest;
pub mod english;
pub mod error;
pub mod install;
pub mod kokoro;
pub mod manifest;
pub mod paths;

pub use error::{Error, Result};
