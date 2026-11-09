import type { ReaderContext, ReaderContribution } from '../../core/capability'
import { ContributionBody, ContributionBoundary } from '../ContributionBoundary'

/**
 * What a capability adds around the reader, drawn by the desktop window.
 *
 * ⚠️ **THE CONTEXT ARRIVES BY RENDER AND NOTHING HERE HOLDS IT BACK**, so a section
 * change reaches a contribution in the commit that shows it. See `ReaderContext`.
 */

/**
 * ⚠️ **SILENT, BECAUSE A HOST HAS NO PLACE IN THE WINDOW TO SAY ANYTHING.** Its
 * failure line would land above the whole shell. The log still names it, and its
 * effects' cleanups have run, so a pace it held is handed back.
 */
export function WindowHosts({
  hosts,
  context,
}: {
  readonly hosts: readonly ReaderContribution[]
  readonly context: ReaderContext
}) {
  return hosts.map((host) => (
    <ContributionBoundary key={host.id} label="A window host" id={host.id} silent>
      <ContributionBody id={host.id} render={host.render} context={context} />
    </ContributionBoundary>
  ))
}

export function ReaderControls({
  controls,
  context,
}: {
  readonly controls: readonly ReaderContribution[]
  readonly context: ReaderContext
}) {
  return controls.map((control) => (
    <ContributionBoundary key={control.id} label="A title bar control" id={control.id}>
      <ContributionBody id={control.id} render={control.render} context={context} />
    </ContributionBoundary>
  ))
}
