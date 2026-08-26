//! The browser client's bundle, embedded at compile time.
//!
//! `build.rs` walks `dist-web/` — what `pnpm build:web` produces — and writes a
//! table of `(path, content_type, include_bytes!(…))` into `OUT_DIR`. This
//! includes it.
//!
//! ## Why the bundle is embedded rather than read from disk
//!
//! Two reasons, and the second is the one that matters.
//!
//! A directory served at runtime is a path-traversal surface to defend and
//! test; a table is a key lookup with no such surface at all
//! (`paper_webhost::assets`).
//!
//! And the client ships INSIDE the app, so a browser and the shelf it talks to
//! are always the same build. A hosted client updates for everyone the moment
//! it is deployed while shelves lag by weeks — which turns wire compatibility
//! from a courtesy into a permanent support window. Embedding removes that
//! problem rather than managing it.
//!
//! ## A tree where `pnpm build:web` has never run still compiles
//!
//! The table is then empty, and the server answers `503` with a sentence
//! saying exactly that. Making `cargo build` depend on a JavaScript build
//! having happened would mean a fresh clone cannot compile the Rust, which is
//! a worse failure than a missing client — and one that fails in a place with
//! nothing to say about the cause.

use paper_webhost::assets::Asset;

include!(concat!(env!("OUT_DIR"), "/client_assets.rs"));

#[cfg(test)]
mod tests {
    use super::CLIENT;

    #[test]
    fn every_embedded_path_is_absolute_and_unique() {
        /* The table is generated, so this is a check on the GENERATOR. A
         * relative key can never be matched — a request path always starts with
         * a slash — and a duplicate key silently shadows whichever came second. */
        let mut seen = std::collections::BTreeSet::new();
        for asset in CLIENT {
            assert!(
                asset.path.starts_with('/'),
                "{} is not a request path",
                asset.path
            );
            assert!(seen.insert(asset.path), "{} is embedded twice", asset.path);
        }
    }

    /**
     * WHAT A TREE WITH NO BUNDLE SERVES — explicitly, rather than by not being
     * tested.
     *
     * A fresh clone compiles with an empty table on purpose: making `cargo
     * build` depend on a JavaScript build having happened is a worse failure
     * than a missing client, and one that fails somewhere with nothing to say
     * about the cause. What that costs is a server with no client, and the
     * answer to that has to be a sentence rather than a 404 — which reads as
     * "wrong address" and sends the reader to check the URL.
     *
     * Asserted over an EMPTY table rather than over `CLIENT`, so this case runs
     * the same way whether or not `pnpm build:web` has.
     */
    #[test]
    fn a_tree_with_no_bundle_says_so_rather_than_answering_not_found() {
        use axum::body::Body;
        use axum::http::{Request, StatusCode};
        use tower::ServiceExt;

        let router = paper_webhost::router(std::sync::Arc::new(paper_webhost::WebHost::new()), &[]);
        let response = tokio_test::block_on(async {
            router
                .oneshot(
                    Request::builder()
                        .uri("/")
                        .body(Body::empty())
                        .expect("a request"),
                )
                .await
                .expect("infallible")
        });
        assert_eq!(
            response.status(),
            StatusCode::SERVICE_UNAVAILABLE,
            "a missing client must not read as a wrong address"
        );
    }

    /// THE END-TO-END PROOF, over the real table and the real router.
    ///
    /// Everything else about this bundle is checked by structure — that keys
    /// are unique, that an entry exists. This asks the actual question: does a
    /// browser asking for `/` get the client?
    #[test]
    fn the_real_router_serves_the_real_bundle_at_the_root() {
        use axum::body::Body;
        use axum::http::{Request, StatusCode};
        use tower::ServiceExt;

        /* ⚠️ **A SILENT SKIP IS NOT A PASS**, and this used to be a bare
         * `return`. `dist-web/` is gitignored, so on a fresh clone the table is
         * empty and this case did nothing — while reporting `ok`, in the exact
         * failure mode where the shipped browser client is missing. A test that
         * cannot run should say so where somebody reading the output sees it.
         *
         * The real guard against shipping an empty bundle is in `build.rs`,
         * which REFUSES a release build with no `index.web.html`. This case is
         * the end-to-end proof and can only run where the bundle exists; the
         * empty-table behaviour has its own case below. */
        if CLIENT.is_empty() {
            eprintln!(
                "SKIPPED the_real_router_serves_the_real_bundle_at_the_root: dist-web/ is empty. \
                 Run `pnpm build:web`. A release build refuses this — see build.rs."
            );
            return;
        }
        let router =
            paper_webhost::router(std::sync::Arc::new(paper_webhost::WebHost::new()), CLIENT);
        let response = tokio_test::block_on(async {
            router
                .oneshot(
                    Request::builder()
                        .uri("/")
                        .body(Body::empty())
                        .expect("a request"),
                )
                .await
                .expect("infallible")
        });

        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(
            response.headers()[axum::http::header::CONTENT_TYPE],
            "text/html; charset=utf-8",
        );
        /* And the policy is on it — the layer that a book's HTML in this origin
         * depends on, applied to the document that loads the client.
         *
         * ASSERTED ON `script-src` SPECIFICALLY. This searched the whole policy
         * for "unsafe-inline", which was true while nothing needed it and
         * became wrong the moment a reading surface existed: `style-src` needs
         * it, and inline CSS cannot execute JavaScript. `script-src` is the
         * boundary — see `paper_webhost::CONTENT_SECURITY_POLICY` and
         * `scripts/csp-effect.mjs`, which measures what the shape does in a
         * real engine rather than asserting what it says. */
        let policy = response
            .headers()
            .get(axum::http::header::CONTENT_SECURITY_POLICY)
            .expect("a policy on the client document")
            .to_str()
            .expect("ascii");
        let script_src = policy
            .split(';')
            .map(str::trim)
            .find(|part| part.starts_with("script-src"))
            .expect("a script-src in the policy");
        assert_eq!(
            script_src, "script-src 'self'",
            "the boundary moved: {policy}"
        );
    }

    #[test]
    fn an_embedded_client_has_an_entry_document() {
        /* Skipped when nothing was built, which is a legitimate state — see the
         * module header. When there IS a bundle, a table without the entry
         * document would serve 404 for every path including `/`, and the only
         * symptom would be a blank page. */
        if CLIENT.is_empty() {
            return;
        }
        assert!(
            CLIENT.iter().any(|asset| asset.path == "/index.web.html"),
            "a bundle was embedded with no /index.web.html in it",
        );
    }
}
