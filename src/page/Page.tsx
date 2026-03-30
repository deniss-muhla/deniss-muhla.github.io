import { useEffect, useRef, type MouseEvent } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

import { profile } from "../data/content";
import heroPhoto from "../../docs/photo/photo_2024-10-09_06-42-38.jpg";
import cvPhoto from "../../docs/photo/photo_2025-10-22_19-42-29.jpg";
import cvMarkdown from "../../resources/cv/source/cv.md?raw";
import styles from "./Page.module.css";

function scrollToCv(e: MouseEvent<HTMLAnchorElement>) {
  e.preventDefault();
  document.getElementById("cv")?.scrollIntoView({ behavior: "smooth" });
}

export function Page() {
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let frameId = 0;

    const updateScrollState = () => {
      frameId = 0;

      const root = rootRef.current;
      if (!root) {
        return;
      }

      const maxScroll = Math.max(
        document.documentElement.scrollHeight - window.innerHeight,
        1,
      );
      const scrollTop = window.scrollY;

      root.toggleAttribute("data-at-top", scrollTop <= 2);
      root.toggleAttribute("data-at-bottom", maxScroll - scrollTop <= 2);
    };

    const requestUpdate = () => {
      if (frameId !== 0) {
        return;
      }

      frameId = window.requestAnimationFrame(updateScrollState);
    };

    updateScrollState();
    window.addEventListener("scroll", requestUpdate, { passive: true });
    window.addEventListener("resize", requestUpdate);

    return () => {
      if (frameId !== 0) {
        window.cancelAnimationFrame(frameId);
      }

      window.removeEventListener("scroll", requestUpdate);
      window.removeEventListener("resize", requestUpdate);
    };
  }, []);

  return (
    <div ref={rootRef} className={styles.root} data-at-top="">
      {/* ── Scroll arrows ── */}
      <span className={styles.arrowDown} aria-hidden="true" />
      <span className={styles.arrowUp} aria-hidden="true" />

      {/* ── Hero ── */}
      <section className={styles.hero}>
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
            Lead front-end engineer building design systems, React platforms,
            and agentic workflows. Eighteen years shaping interfaces across
            European and North&nbsp;American products.
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
