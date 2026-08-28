# Paper

A reading application for EPUB and PDF, built with Tauri 2, React and Rust.

## Please read this before anything else

**This is a personal project, under active development, and nowhere near a
release.**

It is written for one reader's own use. It is not a product, there is no
release, no installer, no support, and no promise that any of it works on your
machine. Version `0.1.1` is not modesty — the thing genuinely is that early.

Concretely, what that means for you:

- **Anything can change without notice**, including on-disk formats. An update
  may not be able to read what an earlier build wrote.
- **Your books are yours to back up.** Do not point this at a library you
  cannot afford to lose.
- **Development happens on macOS.** iOS and Android compositions exist and
  Windows and Linux are intended, but only macOS is exercised regularly.
- **Issues and pull requests are not being solicited.** The licence lets you do
  as you like with the code; it does not come with anyone's time.

If you want a finished EPUB reader today, you want a different repository.

## What it does so far

- Reads EPUB through a fork of
  [`foliate-js`](https://github.com/johnfactotum/foliate-js) pinned to a commit,
  and PDF through `pdf.js`. The fork is deliberate: upstream's API is
  explicitly unstable, and nothing on npm under that name is the author's.
- Marks and notes anchored to the text, kept beside the book
- Optional on-device language model for a "gloss" — a short explanation of a
  word or phrase in the sentence it appears in, as an alternative to a
  dictionary lookup
- Optional sync between the user's own machines, peer to peer

The optional pieces are optional in the real sense: with nothing installed, the
app is a reader and the features are simply absent.

## Building it

```sh
pnpm install
pnpm app           # run it
pnpm verify        # the full gate — types, tests, build, cargo
```

`pnpm app`, not `pnpm tauri dev`. It overlays `src-tauri/tauri.dev.conf.json`,
which exists to set `withGlobalTauri: true` — false in the shipped app, and
required in development by anything that drives the running window. Plain
`tauri dev` starts a build that looks fine and cannot be driven.

`pnpm build` rather than `pnpm typecheck` is the honest check for anything
touching the reader: some failures are visible only to a real build.

## Licence

MIT — see [`LICENSE`](LICENSE).

What Paper ships alongside its own code carries its own terms, and they travel
in [`THIRD-PARTY-NOTICES.md`](THIRD-PARTY-NOTICES.md): four typefaces under
OFL-1.1, the JavaScript libraries bundled into every build, and the Rust crates
the binary links — MIT and Apache-2.0 almost throughout, each reproduced in
full because those licences make the notice a condition of redistribution.
