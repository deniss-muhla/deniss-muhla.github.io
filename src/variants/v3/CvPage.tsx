import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import cvMarkdown from "../../../resources/cv/source/cv.md?raw";
import cvPhoto from "../../../docs/photo/photo_2025-10-22_19-42-29.jpg";
import styles from "./CvPage.module.css";

export function V3CvPage() {
  return (
    <div className={styles.root}>
      <nav className={styles.nav}>
        <a href="/">← Home</a>
        <a href="/downloads/deniss-muhla-cv.pdf" download>
          Download PDF
        </a>
      </nav>
      <article className={styles.document}>
        <img className={styles.photo} src={cvPhoto} alt="Deniss Muhla" />
        <div className={styles.markdown}>
          <ReactMarkdown remarkPlugins={[remarkGfm]}>
            {cvMarkdown}
          </ReactMarkdown>
        </div>
      </article>
    </div>
  );
}
