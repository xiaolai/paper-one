//! Paper's library-wide passage index.
//!
//! A reader asks the library a question and gets passages back, from any book
//! on the shelf, whether or not it is open. Nothing is sent anywhere to build
//! it: the text comes from books already here, and the postings are built on
//! this machine.
//!
//! # Two stores, and the separation is load-bearing
//!
//! ```text
//! <data root>/passages/
//!   text/     the extracted section text, one file per book, versioned
//!   index/    tantivy's postings, rebuildable FROM text/
//!   state.json  what is indexed, at which generation, and what could not be read
//! ```
//!
//! `text/` is what makes a TOKENIZER CHANGE cost a posting rebuild instead of a
//! re-extraction of the whole library. Changing analysis does not require
//! reopening a single EPUB — [`Store::rebuild`] proves it, and its test asserts
//! that no book was asked for.
//!
//! # What this crate does NOT do: extract
//!
//! ⚠️ **THE TEXT ARRIVES ALREADY CANONICAL, FROM THE FRONT END.** There is no
//! EPUB parser here, deliberately, and that is the single most important
//! decision in this plugin. `src/kernel/ui/reader/reanchor.ts` owns the walk
//! that turns a parsed section into one canonical string — and the SAME walk is
//! what lands a hit back on the words. A Rust extractor would be a second
//! implementation of that walk, and the repository has already measured what an
//! asymmetry between two such walks costs: `<p>done</p><p>Start</p>` indexed as
//! `doneStart`, *"a silent, total loss of context"* for every passage near a
//! paragraph start.
//!
//! So the boundary is: **the front end says what the text IS, this crate says
//! where the words ARE.**

pub mod commands;
pub mod error;
pub mod index;
pub mod passage;
pub mod paths;
pub mod plugin;
pub mod state;
pub mod store;
pub mod text;
pub mod tokenize;

pub use error::{Error, Result};
pub use plugin::init;
