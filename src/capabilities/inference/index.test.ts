import { describe, expect, it } from 'vitest'
import { inferenceDownloadLine } from './index'

/**
 * THE STATUS BAR AT REST, which is the state almost every reader is in.
 *
 * `inferenceDownloadLine` is read by `App` on every render of the library
 * status bar, whether or not `inference` is composed — that is the whole point
 * of exporting it from the capability rather than pushing it into the kernel.
 * With the capability absent or not started there is no controller to ask, and
 * the answer has to be `null` rather than a throw or an empty string: the bar
 * draws a third rung only when there IS a line, and at rest it must be
 * byte-for-byte the two-rung ladder it was before any of this existed.
 *
 * A build with `inference` left out is the case that would otherwise be found
 * by a reader opening the shelf and seeing a crash, since nothing else in the
 * suite renders the bar without the capability.
 */
describe('the library status bar line', () => {
  it('is null when the capability is not running', () => {
    expect(inferenceDownloadLine()).toBeNull()
  })
})
