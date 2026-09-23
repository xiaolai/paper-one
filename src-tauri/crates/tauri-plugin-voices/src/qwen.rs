//! The Qwen engine: Chinese, and mixed Chinese and English, on a Mac.
//!
//! `text` decides what to ask for and whether to believe the answer; `engine`
//! is the model itself. The split is deliberate: everything in `text` runs on
//! any machine with no model at all, which is where the guards belong.

pub mod engine;
pub mod text;
