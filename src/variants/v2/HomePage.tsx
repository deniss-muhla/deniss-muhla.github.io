import { profile } from "../../data/content";
import photo from "../../../docs/photo/photo_2024-10-09_06-42-38.jpg";
import styles from "./HomePage.module.css";

export function V2HomePage() {
  return (
    <div className={styles.root}>
      <main className={styles.content}>
        <div className={styles.watermark} aria-hidden="true">
          D
        </div>
        <h1 className={styles.name}>{profile.name}</h1>
        <hr className={styles.rule} />
        <p className={styles.bio}>
          Lead front-end engineer building design systems, React platforms, and
          agentic workflows. Eighteen years shaping interfaces across European
          and North American products.
        </p>

        <nav className={styles.links}>
          <a href={profile.cvUrl}>Read CV</a>
          <a href={profile.pdfUrl} download>
            Download PDF
          </a>
          <a href={`mailto:${profile.email}`}>Email</a>
        </nav>

        <p className={styles.location}>{profile.location}</p>
      </main>

      <img className={styles.photo} src={photo} alt="" />
    </div>
  );
}
