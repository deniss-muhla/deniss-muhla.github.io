import crypto from "node:crypto";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import puppeteer from "puppeteer";
import { remark } from "remark";
import remarkGfm from "remark-gfm";
import remarkHtml from "remark-html";

const thisFile = fileURLToPath(import.meta.url);
const thisDir = path.dirname(thisFile);
const rootDir = path.resolve(thisDir, "..");
const markdownPath = path.join(rootDir, "resources", "cv", "source", "cv.md");
const cvPhotoPath = path.join(rootDir, "resources", "photo", "cv-photo.jpg");
const outputDir = path.join(rootDir, "public", "downloads");
const outputPdfPath = path.join(outputDir, "deniss-muhla-cv.pdf");
const execFileAsync = promisify(execFile);

let pendingGeneration = null;
let lastRenderedHash = "";

function createHash(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function sectionizeHtml(bodyHtml) {
  const sections = [];
  const [introHtml, ...sectionParts] = bodyHtml.split(/(?=<h2>)/);

  if (introHtml?.trim()) {
    sections.push(`<section class="cvSectionIntro">${introHtml}</section>`);
  }

  for (const sectionPart of sectionParts) {
    const trimmedPart = sectionPart.trim();

    if (!trimmedPart) {
      continue;
    }

    const headingMatch = trimmedPart.match(/^<h2>[\s\S]*?<\/h2>/);

    if (!headingMatch) {
      sections.push(`<section class="cvSectionBlock">${trimmedPart}</section>`);
      continue;
    }

    const headingHtml = headingMatch[0];
    const remainderHtml = trimmedPart.slice(headingHtml.length).trim();

    if (!remainderHtml) {
      sections.push(
        `<section class="cvSectionBlock"><div class="cvSectionLead">${headingHtml}</div></section>`,
      );
      continue;
    }

    const entryParts = remainderHtml
      .split(/(?=<h3>)/)
      .map((part) => part.trim())
      .filter(Boolean);

    if (entryParts.length > 0 && entryParts[0].startsWith("<h3>")) {
      const [firstEntry, ...otherEntries] = entryParts;
      sections.push(`
        <section class="cvSectionBlock">
          <div class="cvSectionLead">
            ${headingHtml}
            <section class="cvEntry">${firstEntry}</section>
          </div>
          ${otherEntries
            .map((entryHtml) => `<section class="cvEntry">${entryHtml}</section>`)
            .join("")}
        </section>
      `);
      continue;
    }

    sections.push(`
      <section class="cvSectionBlock">
        <div class="cvSectionLead">
          ${headingHtml}
          ${remainderHtml}
        </div>
      </section>
    `);
  }

  return sections.join("");
}

async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function renderHtml(markdown) {
  const bodyHtml = String(
    await remark().use(remarkGfm).use(remarkHtml).process(markdown),
  );
  const structuredHtml = sectionizeHtml(bodyHtml);
  const avatarDataUrl = await fs.readFile(cvPhotoPath, { encoding: "base64" });

  return `<!doctype html>
  <html lang="en">
    <head>
      <meta charset="UTF-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1.0" />
      <title>Deniss Muhla CV</title>
      <style>
        @import url("https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500&family=Libre+Baskerville:ital,wght@0,400;0,700;1,400&display=swap");

        @page {
          size: A4;
          margin: 16mm 14mm 18mm;
        }

        :root {
          color-scheme: light;
          --page: #ffffff;
          --ink: #4c4f69;
          --ink-sub: #5c5f77;
          --ink-faint: #9ca0b0;
          --line: #ccd0da;
          --accent: #8839ef;
          --accent2: #7287fd;
        }

        * {
          box-sizing: border-box;
        }

        body {
          margin: 0;
          font-family: "Libre Baskerville", Georgia, serif;
          background: var(--page);
          color: var(--ink);
          font-synthesis: none;
          text-rendering: optimizeLegibility;
          -webkit-font-smoothing: antialiased;
          -moz-osx-font-smoothing: grayscale;
        }

        main {
          padding: 0;
        }

        .document {
          margin: 0;
          padding: 20px 0;
          background: white;
        }

        .avatarDoc {
          float: right;
          width: 128px;
          height: 128px;
          margin: 0 0 20px 20px;
          border-radius: 50%;
          object-fit: cover;
          shape-outside: circle();
        }

        .markdown {
          color: var(--ink);
          font-family: "Libre Baskerville", Georgia, serif;
        }

        .cvSectionLead,
        .cvEntry,
        .markdown blockquote,
        .markdown table,
        .markdown ul,
        .markdown ol {
          break-inside: avoid;
          page-break-inside: avoid;
        }

        .markdown p,
        .markdown li {
          orphans: 3;
          widows: 3;
        }

        .markdown * {
          max-width: 100%;
        }

        .markdown h1,
        .markdown h2,
        .markdown h3,
        .markdown p,
        .markdown ul,
        .markdown ol,
        .markdown table,
        .markdown blockquote {
          margin-top: 0;
        }

        .markdown h1 {
          margin: 0 0 8px;
          font-size: 24pt;
          font-weight: 700;
          line-height: 1.08;
          letter-spacing: -0.01em;
          color: var(--ink);
        }

        .markdown h1 + p {
          font-style: italic;
        }

        .markdown h2 {
          margin: 52px 0 18px;
          padding: 0;
          border: none;
          color: var(--accent);
          font-size: 9pt;
          font-weight: 400;
          letter-spacing: 0.22em;
          text-transform: uppercase;
        }

        .markdown h2::after {
          content: "";
          display: block;
          width: 36px;
          height: 1px;
          margin-top: 10px;
          background: var(--accent);
        }

        .markdown h3 {
          margin: 28px 0 6px;
          font-size: 13pt;
          font-weight: 700;
          line-height: 1.2;
          color: var(--ink);
        }

        .markdown p {
          margin: 0 0 12px;
          font-size: 10.6pt;
          line-height: 1.85;
          color: var(--ink-sub);
        }

        .markdown strong {
          color: var(--ink);
        }

        .markdown blockquote {
          clear: both;
          margin: 16px 0 24px;
          padding: 0 0 0 24px;
          border-left: 1px solid var(--accent2);
          background: transparent;
        }

        .markdown blockquote p {
          margin: 0;
          font-size: 10.8pt;
          font-style: italic;
          line-height: 1.8;
          color: var(--ink);
        }

        .markdown ul,
        .markdown ol {
          padding-left: 20px;
          margin-bottom: 14px;
        }

        .markdown li {
          margin-bottom: 4px;
          font-size: 10.6pt;
          line-height: 1.75;
          color: var(--ink-sub);
        }

        .markdown a {
          color: var(--accent2);
          text-decoration: none;
        }

        .markdown table {
          width: 100%;
          border-collapse: collapse;
          margin-bottom: 16px;
        }

        .markdown th,
        .markdown td {
          padding: 10px 12px;
          text-align: left;
          vertical-align: top;
          border-bottom: 1px solid var(--line);
          font-size: 10pt;
          color: var(--ink-sub);
        }

        .markdown th {
          font-size: 8pt;
          font-weight: 400;
          letter-spacing: 0.14em;
          text-transform: uppercase;
          color: var(--ink-faint);
        }

        .markdown hr {
          border: none;
          height: 0;
          margin: 36px 0;
        }

        .markdown hr::after {
          content: "· · ·";
          display: block;
          text-align: center;
          color: #bcc0cc;
          letter-spacing: 0.4em;
          font-size: 0.8rem;
        }

      </style>
    </head>
    <body>
      <main>
        <article class="document">
          <img class="avatarDoc" src="data:image/jpeg;base64,${avatarDataUrl}" alt="Deniss Muhla" />
          <div class="markdown">${structuredHtml}</div>
        </article>
      </main>
    </body>
  </html>`;
}

async function installChrome() {
  const executableName = process.platform === "win32" ? "puppeteer.cmd" : "puppeteer";
  const cliPath = path.join(rootDir, "node_modules", ".bin", executableName);

  await execFileAsync(cliPath, ["browsers", "install", "chrome"], {
    cwd: rootDir,
    env: process.env,
  });
}

async function launchBrowser() {
  try {
    return await puppeteer.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    if (!message.includes("Could not find Chrome")) {
      throw error;
    }

    console.warn("[cv] Chrome not found. Installing browser for PDF generation...");
    await installChrome();

    return puppeteer.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
    });
  }
}

export async function ensureCvArtifacts() {
  const markdown = await fs.readFile(markdownPath, "utf8");
  const currentHash = createHash(markdown);
  const pdfAlreadyExists = await fileExists(outputPdfPath);

  if (currentHash === lastRenderedHash && pdfAlreadyExists) {
    return;
  }

  if (pendingGeneration) {
    return pendingGeneration;
  }

  pendingGeneration = (async () => {
    const html = await renderHtml(markdown);

    await fs.mkdir(outputDir, { recursive: true });

    const browser = await launchBrowser();

    try {
      const page = await browser.newPage();

      await page.setViewport({ width: 1440, height: 2000, deviceScaleFactor: 2 });
      await page.setContent(html, { waitUntil: "networkidle0" });
      await page.emulateMediaType("screen");
      await page.pdf({
        path: outputPdfPath,
        format: "A4",
        printBackground: true,
        margin: {
          top: "16mm",
          right: "14mm",
          bottom: "18mm",
          left: "14mm",
        },
      });
    } finally {
      await browser.close();
    }

    lastRenderedHash = currentHash;
    console.log(`[cv] generated ${path.relative(rootDir, outputPdfPath)}`);
  })().finally(() => {
    pendingGeneration = null;
  });

  return pendingGeneration;
}

if (process.argv[1] && path.resolve(process.argv[1]) === thisFile) {
  ensureCvArtifacts().catch((error) => {
    console.error("[cv] failed to generate PDF", error);
    process.exitCode = 1;
  });
}
