import { useEffect, useRef, useState } from 'react'
import * as pdfjs from 'pdfjs-dist'
import type { TocItem } from 'foliate-js/view.js'
import type { BookMeta, BookNavigator, ReaderPosition } from '../lib/useBook'
import { titleFromSource } from '../lib/formats'
import {
  loadPdf,
  readOutline,
  readPdfMeta,
  searchPdf,
  type OpenPdf,
  type PdfDocument,
} from './pdf'
import styles from './PdfView.module.css'

/**
 * The PDF reader.
 *
 * Deliberately not a `ReaderSession`: that class exists to tame foliate's
 * particular startup chain, and a PDF's is different enough that sharing it
 * would mean generalising a thing whose whole value is being specific. What IS
 * shared is the discipline it encodes — every await is followed by a disposal
 * check, because React can unmount at any point in the chain and a page render
 * that resolves afterwards must not touch a canvas that is gone.
 *
 * Pages are laid out immediately at their true size and painted only when they
 * come near the viewport. Painting all of them up front is what turns a
 * 600-page document into a multi-second freeze and hundreds of megabytes of
 * canvas; laying them out up front is what gives the scrollbar an honest length
 * from the first frame.
 *
 * Worth knowing before debugging a blank page: pdf.js drives its render in
 * chunks scheduled on `requestAnimationFrame`, and WebKit suspends that for an
 * occluded window. So a PDF opened while the window is hidden loads, reports
 * its page count and metadata, and then stops with the canvas blank and the
 * render promise unsettled — no error, nothing in the console. It resumes when
 * the window is visible again. `document.visibilityState` is the tell.
 */

export interface PdfViewProps {
  file: File | string
  generation: number
  onToc: (generation: number, toc: readonly TocItem[]) => void
  onRelocate: (generation: number, position: ReaderPosition) => void
  onMeta: (generation: number, meta: BookMeta) => void
  onError: (generation: number, message: string) => void
  onNavigator: (navigator: BookNavigator | null) => void
}

/** How far outside the viewport a page is painted, in viewport heights. */
const PAINT_MARGIN = '150% 0px'

export function PdfView({
  file,
  generation,
  onToc,
  onRelocate,
  onMeta,
  onError,
  onNavigator,
}: PdfViewProps) {
  const hostRef = useRef<HTMLDivElement>(null)
  const [failed, setFailed] = useState<string | null>(null)

  const handlers = useRef({ onToc, onRelocate, onMeta, onError, onNavigator })
  handlers.current = { onToc, onRelocate, onMeta, onError, onNavigator }

  useEffect(() => {
    const host = hostRef.current
    if (!host) return

    const gen = generation
    const h = handlers.current
    let disposed = false
    let open: OpenPdf | null = null
    const cleanups: (() => void)[] = []

    const fail = (message: string) => {
      if (disposed) return
      setFailed(message)
      h.onError(gen, message)
    }

    void (async () => {
      let opened: OpenPdf
      try {
        opened = await loadPdf(file)
      } catch (cause) {
        fail(cause instanceof Error ? cause.message : 'This PDF could not be opened.')
        return
      }
      // Unmounted while the file was being parsed: the document that just
      // arrived has nothing else holding it, so it is closed here or never.
      if (disposed) {
        opened.destroy()
        return
      }
      open = opened
      const loaded = opened.doc

      h.onMeta(gen, await readPdfMeta(loaded, titleFromSource(file)))
      if (disposed) return

      /* Lay every page out at its true size before painting any of them, so
       * the scrollbar is honest immediately and scrolling to page 400 does not
       * require having painted the 399 before it. */
      const pages: HTMLDivElement[] = []
      const scale = pageScale(host, await loaded.getPage(1))
      if (disposed) return

      for (let n = 1; n <= loaded.numPages; n += 1) {
        const page = await loaded.getPage(n)
        if (disposed) return
        const viewport = page.getViewport({ scale })
        const wrapper = document.createElement('div')
        wrapper.className = styles.page ?? ''
        wrapper.style.width = `${viewport.width}px`
        wrapper.style.height = `${viewport.height}px`
        wrapper.dataset['page'] = String(n)
        host.append(wrapper)
        pages.push(wrapper)
      }

      /* Paint on approach. An IntersectionObserver rather than a scroll
       * handler: it does the intersection maths off the main thread, and it
       * reports pages that arrive because the window was resized too. */
      const painted = new Set<number>()
      const painter = new IntersectionObserver(
        (entries) => {
          for (const entry of entries) {
            if (!entry.isIntersecting) continue
            const wrapper = entry.target as HTMLDivElement
            const n = Number(wrapper.dataset['page'])
            if (painted.has(n)) continue
            painted.add(n)
            void paintPage(loaded, n, scale, wrapper, () => disposed)
          }
        },
        { root: host, rootMargin: PAINT_MARGIN },
      )
      pages.forEach((page) => painter.observe(page))
      cleanups.push(() => painter.disconnect())

      /* Which page is being read, for the footer and the Contents highlight.
       * A second observer rather than reusing the painter's: they want
       * different margins, and one observer cannot have two. */
      const reader = new IntersectionObserver(
        (entries) => {
          if (disposed) return
          const visible = entries
            .filter((entry) => entry.isIntersecting)
            .sort((a, b) => b.intersectionRatio - a.intersectionRatio)[0]
          if (!visible) return
          const n = Number((visible.target as HTMLDivElement).dataset['page'])
          h.onRelocate(gen, {
            fraction: loaded.numPages > 1 ? (n - 1) / (loaded.numPages - 1) : 0,
            chapterLabel: `Page ${n} of ${loaded.numPages}`,
            chapterHref: String(n),
          })
        },
        { root: host, threshold: [0.1, 0.5] },
      )
      pages.forEach((page) => reader.observe(page))
      cleanups.push(() => reader.disconnect())

      h.onToc(gen, await readOutline(loaded))
      if (disposed) return

      h.onNavigator({
        goTo: (target) => {
          const n = Number(target)
          if (!Number.isFinite(n)) return
          pages[n - 1]?.scrollIntoView({ block: 'start' })
        },
        search: async function* (query, signal) {
          for await (const hit of searchPdf(loaded, query, signal)) {
            yield {
              cfi: String(hit.page),
              label: `Page ${hit.page}`,
              pre: hit.pre,
              match: hit.match,
              post: hit.post,
            }
          }
        },
        /* Marks, and therefore the selection popup, are EPUB-only: they are
         * anchored by CFI, which a PDF has no equivalent of. These are no-ops
         * rather than absent so the reader's own wiring needs no special case,
         * and the panel says plainly that PDF marks are not supported. */
        drawMark: () => {},
        eraseMark: () => {},
        deselect: () => window.getSelection()?.removeAllRanges(),
      })
    })()

    return () => {
      disposed = true
      for (const off of cleanups) off()
      h.onNavigator(null)
      host.replaceChildren()
      open?.destroy()
    }
  }, [file, generation])

  if (failed) {
    return <div className={styles.failed}>{failed}</div>
  }
  return <div className={styles.scroller} ref={hostRef} />
}

/** Fit the page to the column it is being read in, at up to 2x. */
function pageScale(host: HTMLElement, page: pdfjs.PDFPageProxy): number {
  const available = host.clientWidth
  const natural = page.getViewport({ scale: 1 }).width
  if (!available || !natural) return 1
  return Math.min(available / natural, 2)
}

/**
 * Paint one page, and lay its text over it.
 *
 * The text layer is transparent and exists so a PDF can be selected and copied
 * like a book rather than being an image of one. It is also what makes the
 * page's words reachable at all — a canvas has no text in it.
 */
async function paintPage(
  doc: PdfDocument,
  n: number,
  scale: number,
  wrapper: HTMLDivElement,
  disposed: () => boolean,
): Promise<void> {
  try {
    const page = await doc.getPage(n)
    if (disposed()) return
    const viewport = page.getViewport({ scale })

    const canvas = document.createElement('canvas')
    canvas.className = styles.canvas ?? ''
    /* Painted at device resolution and then scaled down by CSS. Painting at CSS
     * resolution leaves the type visibly soft on every Retina display. */
    const dpr = window.devicePixelRatio || 1
    canvas.width = Math.floor(viewport.width * dpr)
    canvas.height = Math.floor(viewport.height * dpr)
    canvas.style.width = `${viewport.width}px`
    canvas.style.height = `${viewport.height}px`
    // Attached BEFORE rendering, so the page fills in as it is painted rather
    // than appearing whole, and so pdf.js has a live canvas to work against.
    wrapper.append(canvas)

    /* `canvas`, and NOT `canvasContext` as well.
     *
     * pdf.js 6 takes one or the other: the context is a backwards-compatible
     * path that requires `canvas: null`, and passing both is neither. It does
     * not throw or warn — the render promise simply never settles, so the page
     * stays blank with no error anywhere and every disposal check downstream
     * waits forever on it. */
    await page.render({
      canvas,
      viewport,
      transform: dpr === 1 ? undefined : [dpr, 0, 0, dpr, 0, 0],
    }).promise
    if (disposed()) return

    const textLayerDiv = document.createElement('div')
    textLayerDiv.className = styles.textLayer ?? ''
    wrapper.append(textLayerDiv)
    const textLayer = new pdfjs.TextLayer({
      textContentSource: page.streamTextContent(),
      container: textLayerDiv,
      viewport,
    })
    await textLayer.render()
  } catch (cause) {
    /* A page that will not paint leaves its space blank rather than taking the
     * whole document down — one damaged page should not close the file.
     *
     * But it says so. A bare `catch {}` here is indistinguishable from a page
     * that simply never came into view, which cost an hour of looking at an
     * empty canvas that was actually throwing on every attempt. The marker is
     * for the next person doing that; the log is for this one. */
    wrapper.dataset['failed'] = 'true'
    console.error(`Paper: page ${n} failed to paint`, cause)
  }
}
