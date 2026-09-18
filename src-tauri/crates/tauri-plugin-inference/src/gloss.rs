//! The shape a gloss is answered in — a JSON schema the model's decoder
//! ENFORCES, rather than a format the prompt DESCRIBES.
//!
//! FOUR THINGS READ IT since 2026-09-18: the local `llama-server`'s grammar, an
//! OpenAI-compatible endpoint's structured-output mode, Claude's `--json-schema`
//! and Codex's `--output-schema`. See "Portable" below for what that cost.
//!
//! # Why a schema, and what describing the format in prose cost
//!
//! Measured 2026-09-18 against the live daemon (Qwen3-4B-Instruct-2507, then
//! behind `lemond`), 3 terms × 3 runs, the exact question `glossQuestion`
//! builds.
//! The prompt had gained one line asking for the part of speech as a `pos:`
//! first line, and it broke **7 of 9** answers in ways every reader saw: the
//! part of speech used AS the marker (`verb: replacing…`, so the parse failed
//! soft and drew `verb:` inside the definition), the definition written twice,
//! a dangling `English` line. Every test was green, because they pinned the
//! prompt's TEXT and parsed replies written by hand.
//!
//! A `response_format` schema moves the format out of the model's discretion:
//! llama.cpp compiles it into a grammar and samples only tokens the grammar
//! allows, so a malformed reply is not unlikely, it is impossible. The same
//! baseline prompt with the schema: **9 of 9** well-formed, all with a part of
//! speech. The prompt went back to the wording that had measured clean.
//!
//! # Why the language names are IN the schema
//!
//! Three shapes were measured for WI-17.5's two-language answer, streamed
//! exactly as `inference_gloss` streams, `Answer in: English, then Simplified
//! Chinese`, 3 terms × 3 runs each:
//!
//! | `definition` is | two languages | one language |
//! |---|---|---|
//! | one string, two lines | **0 / 9** — the Chinese line is simply dropped | — |
//! | an array of 1–2 strings | **3 / 9** — the second item is a second ENGLISH sense | **6 / 9** — a second sense as a second item |
//! | an object keyed by language | 9 / 9 — **but always English first**, whatever order was asked | 9 / 9 |
//! | an array, one `{language, text}` per language, `language` a `const` | **9 / 9, in the order asked, both orders** | **9 / 9** |
//!
//! A fixed shape cannot tell the model WHICH language goes in which slot, and
//! a slot the model has to guess at is a slot it fills with whatever it was
//! already writing. Naming the language in the slot is what works, and a
//! single-value constraint makes the decoder write that name before the
//! meaning — so the model has just written `"language": "Simplified Chinese",
//! "text": "` when it starts the sentence. Hence [`response_format`] takes the
//! names.
//!
//! # Portable — and the measured shape was not
//!
//! ⚠️ **THE ARRAY OF `const` ENTRIES ABOVE IS WHAT ONLY llama.cpp ACCEPTS.**
//! Measured 2026-09-18, handed to the other three readers: Claude's strict mode
//! refused the schema outright (`unknown keyword: "prefixItems"`), and OpenAI's,
//! behind Codex, refused it with a 400 (`schema must have a 'type' key`, at the
//! `const`). So the shape was rebuilt from the keywords every strict mode
//! accepts — `type`, `properties`, `required`, `additionalProperties`, `enum` —
//! and `every_keyword_is_one_every_strict_mode_accepts` holds it there.
//!
//! **The tuple became two NAMED SLOTS, `first` and `second`**, each an entry
//! whose `language` is a one-value `enum`. That keeps both properties the
//! tuple bought: the language is written before its meaning, and the slots
//! come in the order asked — because they are keyed by POSITION, not by
//! language, and `first` sorts before `second` (the keyed-by-language object in
//! the table above failed exactly there: its keys sorted `English` first).
//! Measured the same day with the default prompt: Codex 2 of 2 and Claude 2 of
//! 2, well-formed, both languages in the order asked; the local model's 27 are
//! re-measured against it (AGENTS.md, "The inference runtime").
//!
//! ⚠️ **AN OBJECT'S FIELDS ARE WRITTEN IN THE ORDER THE REQUEST CARRIES THEM,
//! AND PAPER'S REQUEST CARRIES THEM SORTED.** Asked `Simplified Chinese, then
//! English`, the keyed object wrote `English` first 3 of 3; and every reply of
//! every shape wrote `definition` before `partOfSpeech`, although this file
//! then declared them the other way round. So an object cannot carry an order
//! and an array must.
//!
//! **THIS SAID llama.cpp SORTED THEM, AND IT DOES NOT** (measured 2026-09-18,
//! after the paragraph was written): a bare `llama-server` keeps whatever order
//! the schema arrives in. Two things sort it before it gets there, and either
//! alone is enough. `serde_json` without its `preserve_order` feature — which
//! nothing in this build enables — holds an object in a `BTreeMap`, so the
//! request Paper SENDS has its keys sorted whatever order `json!` wrote them
//! in. And `lemond` re-sorted when it forwarded the request: its output equalled
//! the bare server's given a pre-sorted schema, byte for byte, 3 of 3.
//!
//! So the order survives lemond's removal, because it was never lemond's
//! alone — and it hangs on a feature flag nobody chose. `schema` therefore
//! DECLARES the order the wire carries, and
//! `the_request_carries_the_fields_in_the_order_the_model_writes_them` pins it
//! on the serialized bytes: enabling `preserve_order` would then change
//! nothing, and reordering the declaration would fail by name. The same order
//! is what puts `language` before `text` inside an entry.
//!
//! # Why the STRUCTURE is built here and only the names come from the caller
//!
//! The crate's one question (see `lib.rs`): could untrusted book HTML reach
//! this? It could — `inference_gloss` is called from the webview that renders
//! it. A schema handed over whole would be a program for llama.cpp's grammar
//! compiler written by that HTML, and a small schema can compile to an
//! enormous grammar (`"minLength": 100000` is a hundred thousand repetitions).
//! So the structure is fixed here, and what crosses IPC is two bounded STRINGS
//! — `limits::MAX_LANGUAGE_NAME` — which `serde_json` escapes into `enum`
//! values: data, never structure. `a_language_name_is_data_and_cannot_add_structure`
//! is the case that says so.
//!
//! # The other half is TypeScript, and one file holds the two together
//!
//! `definitionOf` in `src/capabilities/inference/lib/glossProvider.ts` reads
//! what this schema makes the model write. A protocol whose halves live in two
//! languages is the shape that drifts, so both are held to
//! `fixtures/gloss-response-format.json` — this crate asserts it builds exactly
//! that, and the TypeScript side builds a reply FROM that file and asserts its
//! parse reads it (`endpoint-validation.json` is the same arrangement, for the
//! same reason). Rename a field here and this crate's test goes red; update the
//! fixture and the parse's does.

use serde_json::{json, Value};

/// What the schema is sent as. The OpenAI shape requires a name; nothing reads
/// it back.
const SCHEMA_NAME: &str = "gloss";

/// The `response_format` a gloss is asked with: the part of speech, and one
/// meaning per language — `first`, then `then` when two were asked for.
///
/// ONE OR TWO, BY THE SIGNATURE, which mirrors the kernel's `AnswerLanguages`
/// (`readonly [AnswerLanguage] | readonly [AnswerLanguage, AnswerLanguage]`):
/// no answer languages and three are not values this can be handed.
///
/// `strict` is the OpenAI flag for "the schema is a contract, not a hint";
/// llama.cpp constrains either way, and it costs nothing to say so to a
/// backend that reads it.
pub fn response_format(first: &str, then: Option<&str>) -> Value {
    json!({
        "type": "json_schema",
        "json_schema": {
            "name": SCHEMA_NAME,
            "strict": true,
            "schema": schema(first, then),
        },
    })
}

/// The schema alone — what Claude's `--json-schema` and Codex's
/// `--output-schema` take, where an endpoint and the local server take it
/// inside [`response_format`].
pub fn schema(first: &str, then: Option<&str>) -> Value {
    /* TWO NAMED SLOTS, not a tuple — see "Portable" in the module header. The
    second exists only when a second language was asked, and is then required:
    an optional slot is one the model may leave empty. */
    let mut slots = serde_json::Map::new();
    let mut filled = vec![SLOTS[0]];
    slots.insert(SLOTS[0].to_owned(), entry(first));
    if let Some(then) = then {
        slots.insert(SLOTS[1].to_owned(), entry(then));
        filled.push(SLOTS[1]);
    }
    /* DECLARED IN THE ORDER THE WIRE CARRIES — see the module header. The
    meaning comes first and the part of speech after it, which is also the
    order every measured reply was written in. */
    json!({
        "type": "object",
        "properties": {
            "definition": {
                "type": "object",
                "properties": slots,
                "required": filled,
                "additionalProperties": false,
            },
            "partOfSpeech": { "type": "string" },
        },
        "required": ["definition", "partOfSpeech"],
        "additionalProperties": false,
    })
}

/// The slots' names, in the order a reader asked for the languages — and in
/// the order they SORT, which is the order the wire carries them in.
pub const SLOTS: [&str; 2] = ["first", "second"];

/// One language's meaning, NAMED — see the module header on why the name is
/// what makes the right language arrive in the right place. A one-value `enum`
/// with a `type`, because that is the spelling of "this exact string" every
/// strict mode accepts; `const` was refused by OpenAI's.
fn entry(language: &str) -> Value {
    json!({
        "type": "object",
        "properties": {
            "language": { "type": "string", "enum": [language] },
            "text": { "type": "string" },
        },
        "required": ["language", "text"],
        "additionalProperties": false,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture() -> Value {
        serde_json::from_str(include_str!("../fixtures/gloss-response-format.json"))
            .expect("the shared fixture parses")
    }

    /// The entries, in SLOT order — `first`, then `second` if there is one.
    fn entries(format: &Value) -> Vec<&Value> {
        let slots = format["json_schema"]["schema"]["properties"]["definition"]["properties"]
            .as_object()
            .expect("the definition is an object of named slots");
        SLOTS.iter().filter_map(|slot| slots.get(*slot)).collect()
    }

    fn languages(format: &Value) -> Vec<&str> {
        entries(format)
            .iter()
            .map(|one| {
                let named = one["properties"]["language"]["enum"]
                    .as_array()
                    .expect("each entry names its language as a one-value enum");
                assert_eq!(named.len(), 1, "one language per slot: {named:?}");
                named[0].as_str().expect("a language name")
            })
            .collect()
    }

    /// ⚠️ **ONE FIXTURE, TWO HALVES.** `glossProvider.test.ts` builds a reply
    /// from this same file and asserts `definitionOf` reads it. A field renamed
    /// here alone fails HERE; the fixture updated to match fails THERE until the
    /// parse reads the new name. Whole-value equality, so no key can be added,
    /// dropped or loosened without somebody editing the file both sides read.
    #[test]
    fn the_shape_is_the_one_the_parse_is_held_to() {
        assert_eq!(
            response_format("English", Some("Simplified Chinese")),
            fixture()
        );
    }

    /// The order asked, and exactly as many entries as languages — the two
    /// facts the measured array-of-strings lost and the keyed object could not
    /// keep. Both orders, because "English first" is the one a sorted shape
    /// gets right by accident.
    #[test]
    fn one_entry_per_language_named_in_the_order_asked() {
        assert_eq!(languages(&response_format("English", None)), ["English"]);
        let one = response_format("English", None);
        assert_eq!(
            one["json_schema"]["schema"]["properties"]["definition"]["required"],
            json!(["first"]),
            "one language asked, one slot required and no second slot to fill"
        );
        assert_eq!(
            languages(&response_format("Simplified Chinese", Some("English"))),
            ["Simplified Chinese", "English"]
        );
        assert_eq!(
            languages(&response_format("English", Some("Simplified Chinese"))),
            ["English", "Simplified Chinese"]
        );
    }

    /// ⚠️ **THE NAMES ARE LOAD-BEARING, AND ONLY BECAUSE OF THEIR SPELLING.**
    /// The request carries an object's fields sorted (see the module header —
    /// measured, not assumed), so `language` is written before `text` only
    /// because `l` sorts before `t`. That order is the whole mechanism:
    /// the model writes the language's name and THEN the meaning. Rename `text`
    /// to `definition` and the meaning is written first, blind, and the
    /// two-language answer goes back to whatever the model was already writing.
    #[test]
    fn an_entry_names_its_language_before_its_meaning() {
        let format = response_format("English", Some("Simplified Chinese"));
        for one in entries(&format) {
            let mut names: Vec<&String> = one["properties"]
                .as_object()
                .expect("an entry has properties")
                .keys()
                .collect();
            names.sort();
            assert_eq!(
                names.first().map(|name| name.as_str()),
                Some("language"),
                "the grammar writes {names:?} in this order, so the meaning would be written before the language that primes it"
            );
        }
    }

    /// ⚠️ **ON THE WIRE, NOT IN THE `Value`.** The model writes fields in the
    /// order the request's bytes carry them, and a `Value` compares equal in
    /// any order — so the order is read off the serialized request, which is
    /// what `generate::stream` sends. It holds with or without `serde_json`'s
    /// `preserve_order`, because `schema` declares the order the sort gives.
    #[test]
    fn the_request_carries_the_fields_in_the_order_the_model_writes_them() {
        let wire = serde_json::to_string(&response_format("English", Some("Simplified Chinese")))
            .expect("the format serializes");
        let at = |needle: &str| {
            wire.find(needle)
                .unwrap_or_else(|| panic!("{needle} in {wire}"))
        };
        assert!(
            at("\"definition\":") < at("\"partOfSpeech\":"),
            "the meaning is written before the part of speech: {wire}"
        );
        assert!(
            at("\"language\":") < at("\"text\":"),
            "the language is written before the meaning it primes: {wire}"
        );
        assert!(
            at("\"first\":") < at("\"second\":"),
            "the slots arrive in the order the languages were asked: {wire}"
        );
    }

    /// ⚠️ **PORTABLE BY CONSTRUCTION, AND MEASURED WHERE IT WAS NOT.** Claude's
    /// strict mode refused `prefixItems` and OpenAI's refused a `const` with no
    /// `type` (2026-09-18) — both in a schema llama.cpp had taken happily. So
    /// every key in the schema is one of the few every strict mode accepts, and
    /// every node that constrains a value says its `type`.
    #[test]
    fn every_keyword_is_one_every_strict_mode_accepts() {
        const ACCEPTED: &[&str] = &[
            "type",
            "properties",
            "required",
            "additionalProperties",
            "enum",
        ];
        fn walk(node: &Value, path: &str) {
            let Some(map) = node.as_object() else { return };
            for (key, child) in map {
                assert!(
                    ACCEPTED.contains(&key.as_str()),
                    "{path}: `{key}` is not portable"
                );
                if key == "properties" {
                    let fields = child.as_object().expect("properties is an object");
                    for (name, field) in fields {
                        assert!(field.get("type").is_some(), "{path}.{name} has no `type`");
                        walk(field, &format!("{path}.{name}"));
                    }
                }
            }
        }
        for then in [None, Some("Simplified Chinese")] {
            walk(&schema("English", then), "$");
        }
    }

    /// CLOSED AT EVERY LEVEL: every object requires every field it declares
    /// and admits no other. An optional field is one the model may leave out,
    /// and an open object is one it may add a stray label to — the two failure
    /// shapes the prose format had.
    #[test]
    fn every_object_is_closed_and_every_field_required() {
        fn walk(value: &Value, objects: &mut usize) {
            if let Some(properties) = value.get("properties").and_then(Value::as_object) {
                *objects += 1;
                assert_eq!(value["additionalProperties"], false, "{value}");
                let mut declared: Vec<&str> = properties.keys().map(String::as_str).collect();
                let mut required: Vec<&str> = value["required"]
                    .as_array()
                    .expect("an object lists what it requires")
                    .iter()
                    .map(|name| name.as_str().expect("a field name"))
                    .collect();
                declared.sort_unstable();
                required.sort_unstable();
                assert_eq!(declared, required, "{value}");
            }
            match value {
                Value::Object(map) => map.values().for_each(|child| walk(child, objects)),
                Value::Array(list) => list.iter().for_each(|child| walk(child, objects)),
                _ => {}
            }
        }
        let format = response_format("English", Some("Simplified Chinese"));
        assert_eq!(format["type"], "json_schema");
        assert_eq!(format["json_schema"]["strict"], true);
        let mut objects = 0;
        walk(&format["json_schema"]["schema"], &mut objects);
        // The reply, its definition and the two entries: a walk that found
        // nothing checked nothing.
        assert_eq!(objects, 4);
    }

    /// ⚠️ **A NAME IS DATA.** It arrives from a webview that renders untrusted
    /// book HTML, so one written to look like JSON must stay a string inside an
    /// `enum` — escaped by `serde_json`, never spliced into the schema's
    /// structure, where it could declare a field or a repetition of its own.
    #[test]
    fn a_language_name_is_data_and_cannot_add_structure() {
        let hostile =
            r#"English" }, "evil": { "type": "string", "minLength": 100000 }, "x": { "const": ""#;
        let format = response_format(hostile, None);
        assert_eq!(languages(&format), [hostile]);
        let entry = entries(&format)[0];
        let mut fields: Vec<&str> = entry["properties"]
            .as_object()
            .expect("an entry has properties")
            .keys()
            .map(String::as_str)
            .collect();
        fields.sort_unstable();
        assert_eq!(fields, ["language", "text"]);

        /* And nowhere else either: every KEY in the whole format is one this
        module wrote. The hostile text survives only as a value. */
        fn keys(value: &Value, into: &mut Vec<String>) {
            match value {
                Value::Object(map) => map.iter().for_each(|(key, child)| {
                    into.push(key.clone());
                    keys(child, into);
                }),
                Value::Array(list) => list.iter().for_each(|child| keys(child, into)),
                _ => {}
            }
        }
        let mut hostile_keys = Vec::new();
        keys(&format, &mut hostile_keys);
        let mut plain_keys = Vec::new();
        keys(&response_format("English", None), &mut plain_keys);
        assert_eq!(hostile_keys, plain_keys);
    }
}
