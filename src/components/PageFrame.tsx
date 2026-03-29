import type { ReactNode } from "react";

import styles from "./PageFrame.module.css";

type PageFrameProps = {
  children: ReactNode;
  currentPage: "home" | "cv";
};

const pdfHref = "/downloads/deniss-muhla-cv.pdf";

export function PageFrame({ children, currentPage }: PageFrameProps) {
  const homeClassName =
    currentPage === "home"
      ? `${styles.navLink} ${styles.current}`
      : styles.navLink;
  const cvClassName =
    currentPage === "cv"
      ? `${styles.navLink} ${styles.current}`
      : styles.navLink;

  return (
    <div className={styles.root}>
      <header className={styles.topbar}>
        <a className={styles.brand} href="/">
          <span className={styles.mark}>DM</span>
          <span className={styles.brandText}>
            <strong className={styles.brandTitle}>Deniss Muhla</strong>
            <span className={styles.brandSubtitle}>
              Front-end systems, design systems, agentic workflows
            </span>
          </span>
        </a>

        <nav className={styles.nav} aria-label="Primary">
          <a
            className={homeClassName}
            href="/"
            aria-current={currentPage === "home" ? "page" : undefined}
          >
            Home
          </a>
          <a
            className={cvClassName}
            href="/cv/"
            aria-current={currentPage === "cv" ? "page" : undefined}
          >
            CV
          </a>
          <a className={styles.download} href={pdfHref} download>
            Download PDF
          </a>
        </nav>
      </header>

      {children}

      <footer className={styles.footer}>
        <p>Based in Latvia, working across EU and North-American products.</p>
        <p>Built with React 19, TypeScript 6.0, CSS Modules, and Vite+.</p>
      </footer>
    </div>
  );
}
