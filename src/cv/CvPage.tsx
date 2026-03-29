import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

import { PageFrame } from "../components/PageFrame";
import styles from "./CvPage.module.css";
import cvMarkdown from "../../resources/cv/source/cv.md?raw";

const quickFacts = [
  { label: "Location", value: "Latvia, EU" },
  { label: "Primary role", value: "Lead front-end engineer" },
  {
    label: "Focus",
    value: "Design systems, Web Components, React, agentic workflows",
  },
  { label: "Experience", value: "18+ years" },
];

export function CvPage() {
  return (
    <PageFrame currentPage="cv">
      <main className={styles.page}>
        <aside className={styles.sidebar}>
          <section className={styles.sideCard}>
            <p className={styles.sideEyebrow}>CV / single source</p>
            <h1 className={styles.sideTitle}>
              Same markdown source, site view, and downloadable PDF.
            </h1>
            <p className={styles.sideText}>
              The page content is rendered directly from the markdown CV and the
              PDF download is generated from that same file during build.
            </p>
          </section>

          <section className={styles.sideCard}>
            <div className={styles.actionList}>
              <a
                className={styles.actionPrimary}
                href="/downloads/deniss-muhla-cv.pdf"
                download
              >
                Download PDF
              </a>
              <a
                className={styles.actionLink}
                href="mailto:deniss.muhla@gmail.com"
              >
                Email
              </a>
              <a className={styles.actionLink} href="tel:+37129966072">
                Call / WhatsApp
              </a>
              <a className={styles.actionLink} href="/">
                Back to home
              </a>
            </div>
          </section>

          <section className={styles.sideCard}>
            <p className={styles.sideEyebrow}>Quick facts</p>
            <dl className={styles.factList}>
              {quickFacts.map((fact) => (
                <div className={styles.factRow} key={fact.label}>
                  <dt className={styles.factLabel}>{fact.label}</dt>
                  <dd className={styles.factValue}>{fact.value}</dd>
                </div>
              ))}
            </dl>
          </section>
        </aside>

        <article className={styles.article}>
          <div className={styles.markdown}>
            <ReactMarkdown remarkPlugins={[remarkGfm]}>
              {cvMarkdown}
            </ReactMarkdown>
          </div>
        </article>
      </main>
    </PageFrame>
  );
}
