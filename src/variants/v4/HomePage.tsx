import { profile, focus } from "../../data/content";
import styles from "./HomePage.module.css";

export function V4HomePage() {
  return (
    <div className={styles.root}>
      <main className={styles.content}>
        <div className={styles.spine}>
          <section className={styles.block}>
            <span className={styles.label}>01</span>
            <h1 className={styles.name}>{profile.name}</h1>
            <p className={styles.role}>{profile.role}</p>
          </section>

          <section className={styles.block}>
            <span className={styles.label}>02</span>
            <p className={styles.tagline}>{profile.tagline}</p>
          </section>

          <section className={styles.block}>
            <span className={styles.label}>03</span>
            <ul className={styles.focus}>
              {focus.map((f) => (
                <li key={f}>{f}</li>
              ))}
            </ul>
          </section>

          <section className={styles.block}>
            <span className={styles.label}>04</span>
            <nav className={styles.links}>
              <a href={profile.cvUrl}>cv</a>
              <a href={profile.pdfUrl} download>
                pdf
              </a>
              <a href={`mailto:${profile.email}`}>email</a>
            </nav>
          </section>
        </div>

        <p className={styles.coord}>56.946°N 24.105°E</p>
      </main>
    </div>
  );
}
