/**
 * The example capability's pane — the smallest thing that proves a
 * contributed pane reaches the side pane. Says what it is and why it exists,
 * so a reader who opens it is not left wondering. Styled with the kernel's
 * tokens (`--space-*`, `--text-*`, `--muted`), which every pane inherits.
 */
export function ExamplePane() {
  return (
    <div style={{ padding: 'var(--space-16) var(--space-14)', fontSize: 'var(--text-ui)', lineHeight: 1.6, color: 'var(--muted)' }}>
      <p>This pane comes from the <code>example</code> capability.</p>
      <p>It exists to prove that a capability can put a pane here, and to be removed.</p>
    </div>
  )
}
