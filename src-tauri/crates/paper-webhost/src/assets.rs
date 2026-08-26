//! The browser client's own bytes, served from a table (phase 18, WI-18.4a).
//!
//! ## Why a table and not a directory
//!
//! `tower-http`'s `ServeDir` is the obvious answer and was refused deliberately.
//! Serving from a directory means resolving a request path against a filesystem,
//! which means path traversal is a thing that has to be got right and then
//! tested — `..`, encoded `..`, a symlink out of the tree, a case-insensitive
//! volume matching a name the check did not expect.
//!
//! A table has none of that. A request path is a KEY, it either exists or it
//! does not, and no string a browser can send names a file outside the set. The
//! surface is not defended; it is absent.
//!
//! The second reason is the one the plan cared about: the SPA ships INSIDE the
//! app bundle, so the client and the shelf update together. A hosted SPA
//! updates for everyone the moment it is deployed while shelves lag by weeks,
//! and wire compatibility stops being a courtesy.
//!
//! ## What is served, and with what caching
//!
//! Vite hashes every asset filename, so those are immutable for a year. The
//! entry document is not hashed and must never be cached, or a reader keeps
//! loading last week's client against this week's shelf.

use axum::body::Body;
use axum::http::{header, HeaderValue, StatusCode, Uri};
use axum::response::{IntoResponse, Response};

/// One embedded file.
#[derive(Clone, Copy)]
pub struct Asset {
    /// The request path it answers, with its leading slash: `/assets/x-ab12.js`.
    pub path: &'static str,
    pub content_type: &'static str,
    pub bytes: &'static [u8],
}

/// The entry document's request path, which `/` and every unknown path resolve
/// to. Vite names it after the HTML input, so it is `index.web.html` rather
/// than `index.html`.
const ENTRY: &str = "/index.web.html";

/// A build with no client embedded.
///
/// Not an error at compile time: `cargo build` must work in a tree where
/// `pnpm build:web` has never run, or the Rust build depends on a JavaScript
/// one and a fresh clone cannot compile. The SERVER says so instead, at the
/// only moment it matters.
pub const NO_CLIENT: &[Asset] = &[];

fn find(assets: &'static [Asset], path: &str) -> Option<&'static Asset> {
    assets.iter().find(|asset| asset.path == path)
}

/// Serve one request out of the table.
///
/// Unknown paths fall back to the entry document — the ordinary single-page
/// rule, so a reader who reloads on a deep link gets the app rather than a 404.
/// It cannot shadow the API: `/api/*` and `/ws` are registered routes and are
/// matched before this ever runs.
pub fn serve(assets: &'static [Asset], uri: &Uri) -> Response {
    if assets.is_empty() {
        /* HONEST, AND NOT A 404. A 404 here says "no such page", which sends
         * someone looking for a typo in a URL that is correct. The client was
         * simply never built into this binary. */
        return (
            StatusCode::SERVICE_UNAVAILABLE,
            "Paper: this build has no browser client embedded. Run `pnpm build:web`, then rebuild the app.",
        )
            .into_response();
    }

    let path = uri.path();
    let asset = find(assets, path)
        .or_else(|| {
            if path == "/" {
                find(assets, ENTRY)
            } else {
                None
            }
        })
        .or_else(|| find(assets, ENTRY));

    let Some(asset) = asset else {
        return StatusCode::NOT_FOUND.into_response();
    };

    let mut response = Response::new(Body::from(asset.bytes));
    let headers = response.headers_mut();
    headers.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static(asset.content_type),
    );
    /* THE ENTRY DOCUMENT MUST NEVER BE CACHED. It is what points at the hashed
     * names, and a stale one is a reader running last week's client against
     * this week's shelf.
     *
     * ⚠️ **AND `immutable` IS ONLY TRUE OF A HASHED NAME**, which "everything
     * else" was not. `dist-web/pdfjs/` is copied in verbatim — the WASM
     * modules, the CMaps, the standard fonts — under fixed names that change
     * CONTENT between releases while keeping their spelling. Marked immutable
     * for a year, a browser that had opened one PDF would go on using the old
     * decoder against a new client, and refuse to revalidate: the failure is a
     * scanned book that renders blank, months later, with nothing in the tree
     * to suggest why.
     *
     * A hash is a claim about content, so only a name carrying one may promise
     * the content will not change. Everything else revalidates — `no-cache` is
     * not "do not store", it is "ask first", so an unchanged font still costs
     * a 304 rather than a download. */
    headers.insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static(if asset.path == ENTRY {
            "no-store"
        } else if is_content_hashed(asset.path) {
            "public, max-age=31536000, immutable"
        } else {
            "no-cache"
        }),
    );
    response
}

/// Whether this name carries a content hash, and so cannot change meaning.
///
/// Vite emits `name-B7xK2Qs9.js` — a base-62 digest before the extension,
/// after a dash. Nothing else in the bundle does: `pdfjs/` is copied in
/// verbatim under fixed names whose CONTENT changes between releases, which is
/// exactly the case `immutable` must not be applied to.
///
/// Conservative on purpose. A name this does not recognise revalidates, which
/// costs a 304; a name it recognises wrongly is cached for a year and cannot be
/// corrected.
fn is_content_hashed(path: &str) -> bool {
    let file = path.rsplit('/').next().unwrap_or(path);
    let Some((stem, _extension)) = file.rsplit_once('.') else {
        return false;
    };
    let Some((_name, digest)) = stem.rsplit_once('-') else {
        return false;
    };
    /* Vite's default is eight characters; requiring a length as well as an
     * alphabet keeps an ordinary hyphenated name — `pdf-worker.mjs` — out. */
    digest.len() >= 8
        && digest
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_')
}

/// The content type for a filename, by extension.
///
/// A closed list rather than a guess: an unknown extension is served as
/// `application/octet-stream`, which a browser downloads instead of running.
/// Guessing `text/html` for something unrecognised is how an uploaded file
/// becomes a script in this origin.
pub const fn content_type_for(path: &str) -> &'static str {
    let bytes = path.as_bytes();
    macro_rules! ends {
        ($suffix:literal) => {{
            let suffix = $suffix.as_bytes();
            if bytes.len() < suffix.len() {
                false
            } else {
                let mut i = 0;
                let offset = bytes.len() - suffix.len();
                let mut same = true;
                while i < suffix.len() {
                    if bytes[offset + i] != suffix[i] {
                        same = false;
                    }
                    i += 1;
                }
                same
            }
        }};
    }
    if ends!(".html") {
        "text/html; charset=utf-8"
    } else if ends!(".js") || ends!(".mjs") {
        "text/javascript; charset=utf-8"
    } else if ends!(".css") {
        "text/css; charset=utf-8"
    } else if ends!(".json") {
        "application/json"
    } else if ends!(".woff2") {
        "font/woff2"
    } else if ends!(".svg") {
        "image/svg+xml"
    } else if ends!(".png") {
        "image/png"
    } else if ends!(".jpg") || ends!(".jpeg") {
        "image/jpeg"
    } else if ends!(".webp") {
        "image/webp"
    } else if ends!(".wasm") {
        "application/wasm"
    } else if ends!(".map") {
        "application/json"
    } else {
        "application/octet-stream"
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    static INDEX: Asset = Asset {
        path: ENTRY,
        content_type: "text/html; charset=utf-8",
        bytes: b"<!doctype html>",
    };
    /* A REAL VITE NAME. The fixture used `index-ab12.js`, a four-character
     * digest no build emits — and the length is part of what distinguishes a
     * content hash from an ordinary hyphenated filename. */
    static SCRIPT: Asset = Asset {
        path: "/assets/index-B7xK2Qs9.js",
        content_type: "text/javascript; charset=utf-8",
        bytes: b"console.log(1)",
    };
    /* COPIED IN VERBATIM, under a fixed name whose CONTENT changes between
     * releases. This is what must not be marked immutable. */
    static WASM: Asset = Asset {
        path: "/pdfjs/wasm/openjpeg.wasm",
        content_type: "application/octet-stream",
        bytes: b"\0asm",
    };
    static TABLE: &[Asset] = &[INDEX, SCRIPT, WASM];

    fn get(path: &str) -> Response {
        serve(TABLE, &path.parse::<Uri>().expect("a uri"))
    }

    #[test]
    fn the_root_serves_the_entry_document() {
        let response = get("/");
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(
            response.headers()[header::CONTENT_TYPE],
            "text/html; charset=utf-8"
        );
    }

    #[test]
    fn a_hashed_asset_is_immutable_and_the_entry_is_not_cached() {
        /* The pair that matters. A cached entry document is a reader running
         * last week's client against this week's shelf. */
        assert_eq!(
            get("/assets/index-B7xK2Qs9.js").headers()[header::CACHE_CONTROL],
            "public, max-age=31536000, immutable"
        );
        assert_eq!(get("/").headers()[header::CACHE_CONTROL], "no-store");
    }

    /// ⚠️ **`immutable` IS A PROMISE ONLY A HASHED NAME CAN MAKE.**
    ///
    /// Everything that was not the entry document got a year and `immutable`.
    /// `dist-web/pdfjs/` is copied in verbatim — the WASM decoders, the CMaps,
    /// the standard fonts — under fixed names whose CONTENT changes between
    /// releases. A browser that had opened one PDF would go on using the old
    /// decoder against a new client and refuse to revalidate: a scanned book
    /// that renders blank, months later, with nothing in the tree to explain it.
    #[test]
    fn an_unhashed_asset_revalidates_rather_than_promising_it_cannot_change() {
        assert_eq!(
            get("/pdfjs/wasm/openjpeg.wasm").headers()[header::CACHE_CONTROL],
            "no-cache"
        );
    }

    /// The rule itself, on the names that actually appear.
    #[test]
    fn a_content_hash_is_told_from_an_ordinary_hyphen() {
        for hashed in [
            "/assets/index-B7xK2Qs9.js",
            "/assets/pdf.worker.min-CHFwMXne.mjs",
            "/assets/index-Cv9DGM9l.css",
        ] {
            assert!(is_content_hashed(hashed), "{hashed} carries a digest");
        }
        for plain in [
            "/pdfjs/wasm/openjpeg.wasm",
            "/pdfjs/standard_fonts/FoxitSans.pfb",
            "/index.web.html",
            /* An ordinary hyphenated name, and a digest too short to be one. */
            "/assets/pdf-worker.mjs",
            "/assets/index-ab12.js",
            "/assets/no-extension",
        ] {
            assert!(!is_content_hashed(plain), "{plain} carries no digest");
        }
    }

    #[test]
    fn an_unknown_path_falls_back_to_the_entry_rather_than_404() {
        /* The single-page rule: a reader who reloads on a deep link gets the
         * app, not a 404. */
        let response = get("/some/deep/link");
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(
            response.headers()[header::CONTENT_TYPE],
            "text/html; charset=utf-8"
        );
    }

    #[test]
    fn no_request_path_can_name_a_file_outside_the_table() {
        /* THE PROPERTY A DIRECTORY SERVER HAS TO DEFEND AND A TABLE SIMPLY HAS.
         * None of these can escape, because none of them is a key. They fall
         * back to the entry document like any other unknown path. */
        for hostile in [
            "/../../../../etc/passwd",
            "/%2e%2e/%2e%2e/etc/passwd",
            "/assets/../../../../etc/passwd",
            "/./././../secret",
        ] {
            let response = get(hostile);
            assert_eq!(response.status(), StatusCode::OK);
            assert_eq!(
                response.headers()[header::CONTENT_TYPE],
                "text/html; charset=utf-8",
                "{hostile} reached something that was not the entry document"
            );
        }
    }

    #[test]
    fn a_build_with_no_client_says_so_instead_of_404ing() {
        let response = serve(NO_CLIENT, &"/".parse::<Uri>().expect("a uri"));
        assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
    }

    #[test]
    fn an_unknown_extension_is_not_guessed_as_html() {
        /* Guessing `text/html` for something unrecognised is how a file becomes
         * a script in this origin. */
        assert_eq!(
            content_type_for("/thing.unknown"),
            "application/octet-stream"
        );
        assert_eq!(
            content_type_for("/no-extension"),
            "application/octet-stream"
        );
        assert_eq!(content_type_for("/a.js"), "text/javascript; charset=utf-8");
        assert_eq!(content_type_for("/a.woff2"), "font/woff2");
        assert_eq!(content_type_for("/a.wasm"), "application/wasm");
    }
}
