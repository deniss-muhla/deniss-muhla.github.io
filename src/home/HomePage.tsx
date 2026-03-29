import primaryPortrait from "../assets/profile/portrait-primary.jpg";
import secondaryPortrait from "../assets/profile/portrait-secondary.jpg";
import { PageFrame } from "../components/PageFrame";
import styles from "./HomePage.module.css";

const metrics = [
  {
    label: "Experience",
    value: "18+ years",
    detail: "Product engineering across EU and North-American markets.",
  },
  {
    label: "Core craft",
    value: "Design systems",
    detail:
      "Atomic components, adoption paths, and sustainable UI architecture.",
  },
  {
    label: "Platform",
    value: "React + Web Components",
    detail: "Shared front-end foundations with strong developer ergonomics.",
  },
  {
    label: "Right now",
    value: "Agentic coding",
    detail: "MCP, skills, and structured LLM workflows for real delivery work.",
  },
];

const pillars = [
  {
    title: "Design systems that stay usable",
    copy: "I push component systems toward atomic, modular boundaries so teams can adopt them without drowning in overrides or product-specific forks.",
  },
  {
    title: "Front-end foundations that scale",
    copy: "I like shaping the tree: module boundaries, typed entities, shared primitives, and delivery rules that still leave teams space to move.",
  },
  {
    title: "Practical AI-assisted engineering",
    copy: "I explore agent skills, MCP, scaffolds, and repeatable prompt structures that improve implementation quality instead of producing noise.",
  },
];

const experience = [
  {
    company: "IF P&C Insurance",
    role: "Lead Front-end JavaScript Application Developer",
    period: "2021 - Present",
    body: "Cross-product design system implementation, feedback loops from consuming teams, and a stronger path from component decisions to reliable adoption.",
    stack: "React, TypeScript, Web Components, Cypress, Vite, Azure DevOps",
  },
  {
    company: "Stream Labs",
    role: "Team Lead, Tech Lead, Senior Front-end Developer",
    period: "2014 - 2021",
    body: "Selected React for maintainability, delivered government milestones under pressure, and built smooth archive navigation for large video content libraries.",
    stack: "React, Redux, Next.js, TypeScript, Docker, MS SQL",
  },
  {
    company: "Geidans Solutions Latvia",
    role: "Software Developer and System Integration Engineer",
    period: "2010 - 2014",
    body: "Connected feature delivery with operational reality through monitoring, release automation, bottleneck analysis, and repeatable workflows.",
    stack: "C#, JavaScript, MS SQL, TFS",
  },
];

const currentTracks = [
  "MCP, agent skills, and structured LLM context orchestration.",
  "Design systems spanning React and Web Components without bloating the core.",
  "faux-ui and other agent-first experiments around rendering and interaction.",
  "Generative audio, image, video, and text workflows as part of a wider tooling curiosity.",
];

export function HomePage() {
  return (
    <PageFrame currentPage="home">
      <main className={styles.page}>
        <section className={styles.hero}>
          <div className={styles.heroPanel}>
            <p className={styles.eyebrow}>Personal site / GitHub Pages</p>
            <h1 className={styles.headline}>
              I build front-end systems that teams can scale without losing the
              craft.
            </h1>
            <p className={styles.lead}>
              Front-end engineer focused on design systems, Web Components,
              React platforms, and practical agentic tooling. I care about
              shipping interfaces that stay coherent under real product
              pressure.
            </p>

            <div className={styles.actions}>
              <a className={styles.primaryAction} href="/cv/">
                Open CV
              </a>
              <a
                className={styles.secondaryAction}
                href="/downloads/deniss-muhla-cv.pdf"
                download
              >
                Download PDF
              </a>
              <a
                className={styles.secondaryAction}
                href="mailto:deniss.muhla@gmail.com"
              >
                Email me
              </a>
            </div>

            <dl className={styles.metrics}>
              {metrics.map((item) => (
                <div className={styles.metricCard} key={item.label}>
                  <dt className={styles.metricLabel}>{item.label}</dt>
                  <dd className={styles.metricValue}>{item.value}</dd>
                  <p className={styles.metricDetail}>{item.detail}</p>
                </div>
              ))}
            </dl>
          </div>

          <div className={styles.photoPanel}>
            <div className={styles.spotlight}>
              <img
                className={styles.primaryPhoto}
                src={primaryPortrait}
                alt="Deniss Muhla sitting on a bench outdoors."
              />
            </div>

            <div className={styles.secondaryCard}>
              <img
                className={styles.secondaryPhoto}
                src={secondaryPortrait}
                alt="Deniss Muhla in a more editorial outdoor portrait."
              />
              <div className={styles.floatingNote}>
                <span className={styles.noteLabel}>Current focus</span>
                <strong className={styles.noteTitle}>
                  Agentic coding inside real team workflows
                </strong>
                <p className={styles.noteText}>
                  Reusable skills, scaffolds, and better implementation paths
                  for design-system work.
                </p>
              </div>
            </div>
          </div>
        </section>

        <section className={styles.section}>
          <div className={styles.sectionHeader}>
            <p className={styles.sectionEyebrow}>What I build</p>
            <h2 className={styles.sectionTitle}>
              Structure first. Delivery-minded. Clean enough to live with.
            </h2>
          </div>

          <div className={styles.cardGrid}>
            {pillars.map((pillar) => (
              <article className={styles.card} key={pillar.title}>
                <h3 className={styles.cardTitle}>{pillar.title}</h3>
                <p className={styles.cardCopy}>{pillar.copy}</p>
              </article>
            ))}
          </div>
        </section>

        <section className={styles.sectionAlt}>
          <div className={styles.sectionHeader}>
            <p className={styles.sectionEyebrow}>Selected experience</p>
            <h2 className={styles.sectionTitle}>
              Three roles that shaped how I approach front-end systems.
            </h2>
          </div>

          <div className={styles.experienceGrid}>
            {experience.map((entry) => (
              <article className={styles.experienceCard} key={entry.company}>
                <p className={styles.experiencePeriod}>{entry.period}</p>
                <h3 className={styles.experienceTitle}>{entry.company}</h3>
                <p className={styles.experienceRole}>{entry.role}</p>
                <p className={styles.experienceBody}>{entry.body}</p>
                <p className={styles.experienceStack}>{entry.stack}</p>
              </article>
            ))}
          </div>
        </section>

        <section className={styles.splitSection}>
          <div className={styles.tracksPanel}>
            <p className={styles.sectionEyebrow}>Current tracks</p>
            <h2 className={styles.sectionTitle}>
              The themes I am actively exploring right now.
            </h2>
            <ul className={styles.trackList}>
              {currentTracks.map((track) => (
                <li className={styles.trackItem} key={track}>
                  {track}
                </li>
              ))}
            </ul>
          </div>

          <aside className={styles.quotePanel}>
            <p className={styles.quoteText}>
              “A design system should stay atomic enough to serve many teams,
              not turn into one team’s product with a global name.”
            </p>
            <p className={styles.quoteCaption}>
              One of the strongest lessons from cross-product design-system work
              at IF.
            </p>
          </aside>
        </section>

        <section className={styles.ctaPanel}>
          <div>
            <p className={styles.sectionEyebrow}>Need the fuller picture?</p>
            <h2 className={styles.sectionTitle}>
              The CV page uses a single markdown source and the downloadable PDF
              is generated from the same file.
            </h2>
          </div>

          <div className={styles.ctaButtons}>
            <a className={styles.primaryAction} href="/cv/">
              Read the CV
            </a>
            <a
              className={styles.secondaryAction}
              href="/downloads/deniss-muhla-cv.pdf"
              download
            >
              Save the PDF
            </a>
          </div>
        </section>
      </main>
    </PageFrame>
  );
}
