import { profile, focus } from "../../data/content";
import photo from "../../../docs/photo/photo_2024-10-09_06-42-38.jpg";
import styles from "./HomePage.module.css";

export function V1HomePage() {
  return (
    <div className={styles.root}>
      <div className={styles.stage}>
        <div className={styles.orbit1}>
          <span className={styles.dot1} />
        </div>
        <div className={styles.orbit2}>
          <span className={styles.dot2} />
        </div>
        <div className={styles.orbit3}>
          <img className={styles.avatar} src={photo} alt="" />
        </div>

        <main className={styles.content}>
          <p className={styles.label}>{profile.role}</p>
          <h1 className={styles.name}>{profile.name}</h1>
          <p className={styles.tagline}>{profile.tagline}</p>

          <nav className={styles.links}>
            <a href={profile.cvUrl}>CV</a>
            <span className={styles.sep} aria-hidden="true">
              ·
            </span>
            <a href={profile.pdfUrl} download>
              PDF
            </a>
            <span className={styles.sep} aria-hidden="true">
              ·
            </span>
            <a href={`mailto:${profile.email}`}>Email</a>
          </nav>
        </main>
      </div>

      <footer className={styles.footer}>
        {focus.map((f) => (
          <span key={f}>{f}</span>
        ))}
      </footer>
    </div>
  );
}
