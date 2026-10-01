import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type MouseEvent,
} from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

import { profile } from "../data/content";
import heroPhoto from "../../resources/photo/hero-photo.jpg";
import cvPhoto from "../../resources/photo/cv-photo.jpg";
import cvMarkdown from "../../resources/cv/source/cv.md?raw";
import styles from "./Page.module.css";

const headingSelector = "h1, h2, h3, h4, h5, h6";
const smoothScrollFallbackMs = 1200;
/**
 * Slack used when comparing scroll positions. It absorbs sub-pixel scroll
 * rounding while staying well under the smallest gap between headings on the
 * page, so neighbouring headings can never collapse into the same stop.
 */
const scrollTolerancePx = 16;
const maxHeadingLabelLength = 48;

type NavStop = {
  element: HTMLElement;
  label: string;
  /** Distance the heading rests below the viewport top, i.e. its scroll margin. */
  landing: number;
};

function readHeadingLabel(element: HTMLElement): string {
  // `innerText` honours <br> and block layout, so "Deniss<br />Muhla" reads
  // as two words instead of "DenissMuhla".
  const text = (element.innerText || element.textContent || "")
    .replace(/\s+/g, " ")
    .trim();

  if (!text) {
    return "Section";
  }

  return text.length > maxHeadingLabelLength
    ? `${text.slice(0, maxHeadingLabelLength - 1).trimEnd()}…`
    : text;
}

/**
 * Scroll position that brings a stop to rest, derived from its live rect so it
 * stays correct after layout shifts, and clamped to the scrollable range.
 * The first stop always resolves to the top of the page.
 */
function getStopTarget(
  stop: NavStop,
  scrollTop: number,
  isFirst: boolean,
): number {
  if (isFirst) {
    return 0;
  }

  const { top } = stop.element.getBoundingClientRect();
  const maxScroll = Math.max(
    document.documentElement.scrollHeight - window.innerHeight,
    0,
  );

  return Math.min(Math.max(top + scrollTop - stop.landing, 0), maxScroll);
}

/**
 * Derives the page's navigation stops from its own headings, in document
 * order, so new sections need no code change.
 *
 * Headings near the end of the document can rest below the maximum scroll
 * position and are therefore unreachable on their own. Clamping merges those
 * into a single stop at the end of the page instead of leaving dead steps.
 */
function collectStops(root: HTMLElement): NavStop[] {
  const stops: NavStop[] = [];

  for (const element of root.querySelectorAll<HTMLElement>(headingSelector)) {
    // Skip anything not actually rendered, e.g. content hidden by print CSS.
    if (element.getClientRects().length === 0) {
      continue;
    }

    const landing = Number.parseFloat(getComputedStyle(element).scrollMarginTop) || 0;
    const previous = stops.at(-1);
    const previousTarget = previous
      ? getStopTarget(previous, window.scrollY, false)
      : null;
    const target = getStopTarget(
      { element, label: "", landing },
      window.scrollY,
      stops.length === 0,
    );

    if (previousTarget !== null && target <= previousTarget + scrollTolerancePx) {
      continue;
    }

    stops.push({ element, label: readHeadingLabel(element), landing });
  }

  return stops;
}

/**
 * Finds the stop the reader is currently on, using live viewport rects.
 *
 * The first stop is treated as reached while the page is still at the top and
 * the last one once the page is scrolled out, so both ends of the document
 * stay reachable.
 */
function findActiveStop(
  stops: NavStop[],
  scrollTop: number,
  isAtTop: boolean,
  isAtBottom: boolean,
): number {
  if (stops.length === 0) {
    return 0;
  }

  if (isAtTop) {
    return 0;
  }

  if (isAtBottom) {
    return stops.length - 1;
  }

  let activeIndex = 0;

  for (const [index, stop] of stops.entries()) {
    if (getStopTarget(stop, scrollTop, index === 0) <= scrollTop + scrollTolerancePx) {
      activeIndex = index;
    }
  }

  return activeIndex;
}

function scrollToCv(e: MouseEvent<HTMLAnchorElement>) {
  e.preventDefault();
  document.getElementById("cv")?.scrollIntoView({ behavior: "smooth" });
}

export function Page() {
  const rootRef = useRef<HTMLDivElement>(null);
  const [stops, setStops] = useState<NavStop[]>([]);
  const [activeIndex, setActiveIndex] = useState(0);

  useEffect(() => {
    const root = rootRef.current;

    if (!root) {
      return;
    }

    let frameId = 0;
    let collected = collectStops(root);

    const measure = () => {
      collected = collectStops(root);
      setStops(collected);
    };

    const updateScrollState = () => {
      frameId = 0;

      const maxScroll = Math.max(
        document.documentElement.scrollHeight - window.innerHeight,
        1,
      );
      const scrollTop = window.scrollY;
      const isAtTop = scrollTop <= 2;
      const isAtBottom = maxScroll - scrollTop <= 2;

      root.toggleAttribute("data-at-top", isAtTop);
      root.toggleAttribute("data-at-bottom", isAtBottom);

      const nextIndex = findActiveStop(collected, scrollTop, isAtTop, isAtBottom);

      setActiveIndex((current) => (current === nextIndex ? current : nextIndex));
    };

    const requestUpdate = () => {
      if (frameId !== 0) {
        return;
      }

      frameId = window.requestAnimationFrame(updateScrollState);
    };

    const remeasure = () => {
      measure();
      requestUpdate();
    };

    measure();
    updateScrollState();

    window.addEventListener("scroll", requestUpdate, { passive: true });
    window.addEventListener("resize", remeasure);
    window.addEventListener("load", remeasure);

    const observer = new ResizeObserver(remeasure);
    observer.observe(root);

    return () => {
      if (frameId !== 0) {
        window.cancelAnimationFrame(frameId);
      }

      observer.disconnect();
      window.removeEventListener("scroll", requestUpdate);
      window.removeEventListener("resize", remeasure);
      window.removeEventListener("load", remeasure);
    };
  }, []);

  const pendingRestoreRef = useRef<(() => void) | null>(null);

  // Cancel any queued focus restore, e.g. when a second click interrupts the scroll.
  const clearPendingRestore = useCallback(() => {
    pendingRestoreRef.current?.();
    pendingRestoreRef.current = null;
  }, []);

  useEffect(() => clearPendingRestore, [clearPendingRestore]);

  const goToStop = useCallback(
    (index: number) => {
      clearPendingRestore();

      const stop = stops[index];

      if (!stop) {
        return;
      }

      const focusBefore = document.activeElement as HTMLElement | null;
      const shouldRestoreFocus =
        focusBefore !== null && focusBefore !== document.body;

      // Chrome cancels an in-flight smooth scroll while any element holds
      // focus, so release focus before animating and give it back once the
      // page has settled.
      focusBefore?.blur();

      // Scroll to a fixed position rather than using `scrollIntoView`: the
      // hero heading sits inside content that a scroll-driven animation
      // translates, so its rect moves while the scroll is still animating and
      // `scrollIntoView` would chase it and overshoot.
      window.scrollTo({
        top: getStopTarget(stop, window.scrollY, index === 0),
        behavior: "smooth",
      });

      if (!shouldRestoreFocus || !focusBefore) {
        return;
      }

      const restore = () => {
        pendingRestoreRef.current = null;
        document.removeEventListener("scrollend", restore);

        const stillUsable =
          focusBefore.isConnected &&
          !(focusBefore instanceof HTMLButtonElement && focusBefore.disabled);

        if (stillUsable) {
          focusBefore.focus({ preventScroll: true });
        }
      };

      // `scrollend` fires on the scrolling element, not the target element.
      document.addEventListener("scrollend", restore, { once: true });
      const fallbackId = window.setTimeout(restore, smoothScrollFallbackMs);

      pendingRestoreRef.current = () => {
        window.clearTimeout(fallbackId);
        document.removeEventListener("scrollend", restore);
      };
    },
    [clearPendingRestore, stops],
  );

  const canGoUp = activeIndex > 0;
  const canGoDown = activeIndex < stops.length - 1;
  const upLabel = stops[activeIndex - 1]?.label;
  const downLabel = stops[activeIndex + 1]?.label;

  return (
    <div ref={rootRef} className={styles.root} data-at-top="">
      {/* ── Scroll arrows ── */}
      <button
        type="button"
        className={styles.arrowUp}
        onClick={() => goToStop(activeIndex - 1)}
        disabled={!canGoUp}
        aria-label={
          upLabel ? `Scroll to previous section: ${upLabel}` : "Scroll up"
        }
        title={upLabel ? `Previous: ${upLabel}` : "Previous section"}
      />
      <button
        type="button"
        className={styles.arrowDown}
        onClick={() => goToStop(activeIndex + 1)}
        disabled={!canGoDown}
        aria-label={
          downLabel ? `Scroll to next section: ${downLabel}` : "Scroll down"
        }
        title={downLabel ? `Next: ${downLabel}` : "Next section"}
      />

      {/* ── Hero ── */}
      <section id="top" className={styles.hero}>
        <main className={styles.heroContent}>
          <div className={styles.watermark} aria-hidden="true">
            D
          </div>
          <h1 className={styles.heroName}>
            Deniss
            <br />
            Muhla
          </h1>
          <hr className={styles.heroRule} />
          <p className={styles.heroBio}>
            Senior front-end engineer building React and TypeScript applications,
            reusable UI components, and AI-assisted development workflows.
            <br />
            Hands-on development, architecture, and technical leadership across
            European and North American products.
          </p>

          <nav className={styles.heroLinks}>
            <a href="#cv" onClick={scrollToCv}>
              Read CV
            </a>
            <a href={`mailto:${profile.email}`}>Email</a>
          </nav>

          <p className={styles.heroLocation}>{profile.location}</p>
          <img className={styles.avatarFloat} src={heroPhoto} alt="" />
        </main>
      </section>

      {/* ── CV ── */}
      <section id="cv" className={styles.cvSection}>
        <header className={styles.cvHeader}>
          <a
            className={styles.cvBackLink}
            href="#"
            onClick={(e) => {
              e.preventDefault();
              window.scrollTo({ top: 0, behavior: "smooth" });
            }}
          >
            ↑ Back to top
          </a>
          <a className={styles.cvDownload} href={profile.pdfUrl} download>
            Download PDF
          </a>
        </header>

        <article className={styles.document}>
          <img className={styles.avatarDoc} src={cvPhoto} alt="Deniss Muhla" />
          <div className={styles.markdown}>
            <ReactMarkdown remarkPlugins={[remarkGfm]}>
              {cvMarkdown}
            </ReactMarkdown>
          </div>
        </article>
      </section>
    </div>
  );
}
