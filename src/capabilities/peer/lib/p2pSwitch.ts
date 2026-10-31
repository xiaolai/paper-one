import { notifyAll } from '../../../kernel'

/**
 * What the reader sees the switch called, here and on every row that follows it.
 * One spelling, because "Follows Peer-to-peer" has to name a switch that exists.
 */
export const P2P_SWITCH_TITLE = 'Peer-to-peer'

/**
 * The reader's P2P switch for one run of the app.
 *
 * Lives here rather than in the pane's state because Settings unmounts the pane
 * when it closes: a choice held in the component reads the launch's answer on
 * reopening, while the file says otherwise.
 */
export interface P2pSwitch {
  /** The answer this run composed around; the screens follow it until a relaunch. */
  readonly launchedOn: boolean
  /** The current answer, including a change made in this run. */
  readonly chosen: () => boolean
  /** Whether what this run is doing still differs from the answer. */
  readonly needsReopen: () => boolean
  readonly set: (on: boolean) => Promise<void>
  /** Told when an answer lands, which can be after the pane that asked has gone. */
  readonly subscribe: (listener: () => void) => () => void
}

export function createP2pSwitch(launchedOn: boolean, write: (on: boolean) => Promise<void>): P2pSwitch {
  let chosen = launchedOn
  /* Off closes the transport for the rest of the run, so a run that started on
     and went off cannot get it back by going on again: only a launch can. */
  let closed = false
  const listeners = new Set<() => void>()
  return {
    launchedOn,
    chosen: () => chosen,
    needsReopen: () => chosen !== launchedOn || closed,
    set: async (on) => {
      await write(on)
      chosen = on
      if (launchedOn && !on) closed = true
      notifyAll(listeners, 'P2P switch')
    },
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
}
