import { profile } from "../../data/content";
import styles from "./HomePage.module.css";

export function V5HomePage() {
  return (
    <div className={styles.root}>
      <main className={styles.content}>
        <h1 className={styles.name}>{profile.name}</h1>
        <p className={styles.role}>
          Front-end engineer. Design systems. React. Agentic workflows.
          <span className={styles.cursor} />
        </p>

        <nav className={styles.links}>
          <a href={profile.cvUrl}>cv</a>
          <a href={profile.pdfUrl} download>
            pdf
          </a>
          <a href={`mailto:${profile.email}`}>email</a>
        </nav>
      </main>
    </div>
  );
}
