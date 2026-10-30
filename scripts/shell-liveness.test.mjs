import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * How a shell script under `scripts/` may ask whether Paper is running.
 *
 * ⚠️ **THREE SCRIPTS MADE THE SAME MISTAKE AND EACH WROTE IT DOWN SEPARATELY.**
 * `pgrep -x Paper` CANNOT EVER MATCH: a Tauri bundle names its executable after
 * the Cargo target, so the process is `app`. A check spelled that way answers
 * "not running" whatever is on screen — which reads as a clean result, skips
 * whatever it guarded, and sends the reader after a healthy install. It cost an
 * hour in `sync-scenario.sh`, fifteen minutes of a two-machine run in a deploy
 * that replaced a bundle under two live processes, and it survived in
 * `shot-window.sh`'s fallback — the one path that exists FOR the installed
 * build — until an audit read it.
 *
 * The second shape is subtler and is what `sync-scenario.sh` was left holding
 * after it fixed the first: `-f` matches whole COMMAND LINES, so it also matches
 * any shell whose argv carries the pattern. Inside a string handed to another
 * shell — `ssh host "… pgrep -f 'Paper.app/…' …"` as a compound command — the
 * remote `sh -c` finds ITSELF, so the answer is "running" unconditionally. The
 * satchel's quit reported a force-kill on every clean quit, and the `pkill -f`
 * on the next line aimed at the shell that had asked.
 *
 * `-f` is not banned outright, because there is one question only a command line
 * can answer: WHICH CHECKOUT a dev binary belongs to. `shot-window.sh` greps its
 * own repository path for that, and is safe doing it — a simple command in
 * `$( )` execs, leaving no shell to match.
 *
 * Both rules are mechanical, so neither depends on the next reader having read
 * the three comments.
 */

const SCRIPTS = fileURLToPath(new URL('.', import.meta.url))

const shellScripts = () =>
  readdirSync(SCRIPTS, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.sh'))
    .map((entry) => join(SCRIPTS, entry.name))

/** A script's code, with full-line comments dropped so prose about the rule
 *  is not read as a breach of it. */
const codeOf = (file) =>
  readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('#'))

describe('how a shell script asks whether Paper is running', () => {
  it('finds the shell scripts it is about', () => {
    /* NON-VACUOUS. Both rules below pass trivially over an empty list, which is
       the failure shape this whole file exists to refuse. */
    const found = shellScripts().map((file) => file.slice(SCRIPTS.length))
    expect(found.length).toBeGreaterThan(3)
    expect(found).toContain('sync-scenario.sh')
    expect(found).toContain('shot-window.sh')
  })

  it('never greps for a process called Paper, which no Tauri bundle has', () => {
    const offenders = shellScripts()
      .filter((file) => codeOf(file).some((line) => /pgrep\s+(-\w+\s+)*-x\s+'?Paper'?/.test(line)))
      .map((file) => file.slice(SCRIPTS.length))
    expect(offenders).toEqual([])
  })

  it('never matches a command line inside a command handed to another shell', () => {
    const offenders = []
    for (const file of shellScripts()) {
      const lines = codeOf(file)
      lines.forEach((line, index) => {
        /* `remote_sh` and a bare `ssh` both hand a string to a remote shell.
           The pattern may sit on a continuation line, so the two lines after
           the call are read with it. */
        if (!/\b(remote_sh|ssh)\b/.test(line)) return
        const window = lines.slice(index, index + 3).join('\n')
        if (/\b(pgrep|pkill)\s+(-\w+\s+)*-f\b/.test(window)) {
          offenders.push(`${file.slice(SCRIPTS.length)}:${index + 1}`)
        }
      })
    }
    expect(offenders).toEqual([])
  })
})
