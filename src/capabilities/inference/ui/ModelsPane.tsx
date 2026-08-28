import { useEffect, useSyncExternalStore } from 'react'
import { CAPABILITY_UI as ui } from '../../../kernel'
import { formatBytes, modelAction, modelValue, runtimeValue, type ModelsModel } from './modelsModel'

/**
 * The **Local models** section (`inference:models`, order 15), rendered by
 * the kernel's Settings pane.
 *
 * Decisions live in `modelsModel.ts` (tested, no React); this adapter draws
 * the snapshot. Drawn with `CAPABILITY_UI`, the kernel's public class
 * vocabulary — nothing here invents a colour, a radius, a height or a
 * control.
 *
 * # No progress bar, and no dropdown
 *
 * F3. The vocabulary is fourteen frozen class names and none of them is a
 * bar, a spinner or a menu, so a download's progress goes in the same
 * right-hand `value` slot every other fact goes in. Reaching for a new class
 * on behalf of a feature that has not proved it needs one is how a design
 * system stops being one.
 *
 * # It costs nothing until it is opened
 *
 * Contributed sections render inside a `PaneGroup` that is closed by default,
 * and a closed group does not mount its children — `Settings.tsx` says so,
 * and says it is what stops Storage reading the disk for a surface nobody
 * opened. The model catalogue inherits that for free: the `useEffect` below
 * is the first read, and it runs when the reader opens the group.
 */

export function ModelsPane({ model }: { readonly model: ModelsModel }) {
  const snapshot = useSyncExternalStore(model.subscribe, model.getSnapshot)
  useEffect(() => {
    void model.refresh()
  }, [model])

  const { runtime } = snapshot
  /* Any operation on the store — an install OR a removal — holds the
     controls; `busy` tracked installs only, so a double-click on Remove
     started a second removal the daemon refused. */
  const busy = snapshot.installing !== null || snapshot.removing !== null

  return (
    <div className={ui.section}>
      <div className={ui.row}>
        <span className={ui.grow}>Runtime</span>
        <span className={ui.value}>{runtimeValue(runtime)}</span>
      </div>
      <div className={ui.hint}>
        Answers, and looking a word up, are produced on this machine. Nothing you
        ask leaves it.
      </div>
      {/* WHAT WENT WRONG WITH THE LAST DOWNLOAD OR REMOVAL. Both buttons below
          are `void`-ed, so neither can report anything by rejecting; before
          this the reader pressed Remove, nothing happened, and nothing said
          why. Same slot and same voice as `Test voice`'s failure line. */}
      {snapshot.failure === null ? null : <div className={ui.hint}>{snapshot.failure}</div>}
      {/* WHY NOTHING BELOW OFFERS INSTALL (WI-20.21). Said once here rather
          than once per row: the rows show the reason in their value slot, and
          this is the sentence that says what would change it. */}
      {runtime.kind === 'absent' ? (
        <div className={ui.hint}>
          The runtime is not installed, so no model could run — nothing is
          offered until it is.
        </div>
      ) : null}

      {snapshot.models.map((entry) => {
        const action = modelAction(entry, runtime)
        return (
          <div key={entry.id} className={ui.row}>
            <span className={ui.grow}>
              {entry.label}
              {entry.quantization ? ` ${entry.quantization}` : ''}
            </span>
            <span className={ui.value}>{modelValue(entry, runtime)}</span>
            {/* NO CONTROL for a model that cannot run — §07's disabled-and-
                says-why, with the why already in the value slot. A disabled
                Install would be a control that cannot act, dressed as one. */}
            {action === 'runtime-missing' ? null : action === 'cancel' ? (
              <button type="button" className={ui.button} onClick={() => model.cancelInstall()}>
                Cancel
              </button>
            ) : action === 'remove' ? (
              <button
                type="button"
                className={`${ui.button} ${ui.buttonDanger}`}
                disabled={busy}
                onClick={() => void model.uninstall(entry.id)}
              >
                Remove
              </button>
            ) : (
              <button
                type="button"
                className={ui.button}
                disabled={busy}
                onClick={() => void model.install(entry.id)}
              >
                Install
              </button>
            )}
          </div>
        )
      })}
      {snapshot.models.map((entry) => (
        <div key={`${entry.id}-license`} className={ui.hint}>
          {entry.label} · {entry.license}
        </div>
      ))}

      {/* `Test voice` — the minimum honest consumer of a TTS model (WI-15.9).
          Absent entirely until a voice is installed: a control that cannot do
          anything is §07's "disabled and says why" with nothing to say. */}
      {snapshot.models.some((entry) => entry.modality === 'speech' && entry.installed) ? (
        <div className={ui.row}>
          <span className={ui.grow}>Test voice</span>
          <span className={ui.value}>
            {snapshot.voiceTest === 'speaking'
              ? 'Speaking…'
              : snapshot.voiceTest === 'failed'
                ? 'That could not be played'
                : ''}
          </span>
          {snapshot.voiceTest === 'speaking' ? (
            <button type="button" className={ui.button} onClick={() => model.stopVoice()}>
              Stop
            </button>
          ) : (
            <button type="button" className={ui.button} onClick={() => void model.testVoice()}>
              Play
            </button>
          )}
        </div>
      ) : null}

      {/* "KEEP MODEL LOADED" IS GONE, NOT HIDDEN. The checkbox persisted a
          setting that nothing read — no spawn flag, no daemon config, no
          unload policy consumed it — so it was a control that did nothing
          and said otherwise. It comes back with its consumer, as a `<label>`
          so the text toggles it and a screen reader can name it. */}
      <div className={ui.hint}>
        Off frees the memory a few minutes after you stop asking.
      </div>

      <div className={ui.row}>
        <span className={ui.grow}>Memory</span>
        {/* `—`, never `0`: an absent figure is not a claim that nothing is
            resident. See `formatBytes`. */}
        <span className={ui.value}>{formatBytes(snapshot.residentBytes)}</span>
      </div>

      <div className={ui.row}>
        <span className={ui.grow}>Models folder</span>
        <span className={`${ui.value} ${ui.code}`}>{snapshot.modelsDir ?? '—'}</span>
      </div>
    </div>
  )
}
