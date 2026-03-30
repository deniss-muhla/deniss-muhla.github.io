import { profile, focus } from "../../data/content";
import photo from "../../../docs/photo/photo_2024-10-09_06-42-38.jpg";
import styles from "./HomePage.module.css";

export function V3HomePage() {
  return (
    <div className={styles.root}>
      <header className={styles.top}>
        <img className={styles.avatar} src={photo} alt="" />
        <span className={styles.mono}>{profile.location}</span>
      </header>

      <main className={styles.content}>
        <h1 className={styles.name}>{profile.name}</h1>
        <p className={styles.role}>{profile.role}</p>

        <div className={styles.divider} />

        <ul className={styles.focus}>
          {focus.map((f) => (
            <li key={f}>{f}</li>
          ))}
        </ul>

        <div className={styles.divider} />

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
