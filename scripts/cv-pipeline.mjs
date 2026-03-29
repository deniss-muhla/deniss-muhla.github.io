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
const outputDir = path.join(rootDir, "public", "downloads");
const outputPdfPath = path.join(outputDir, "deniss-muhla-cv.pdf");
const execFileAsync = promisify(execFile);

let pendingGeneration = null;
let lastRenderedHash = "";

function createHash(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
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

  return `<!doctype html>
  <html lang="en">
    <head>
      <meta charset="UTF-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1.0" />
      <title>Deniss Muhla CV</title>
      <style>
        @page {
          size: A4;
          margin: 16mm 14mm 18mm;
        }

        :root {
          color-scheme: light;
          --page: #f7f1ea;
          --card: #fffdf9;
          --ink: #1d191d;
          --muted: #5f555b;
          --line: rgba(50, 34, 42, 0.15);
          --accent: #7b2133;
          --accent-soft: #cf9f72;
        }

        * {
          box-sizing: border-box;
        }

        body {
          margin: 0;
          font-family: "Segoe UI", "Helvetica Neue", Arial, sans-serif;
          background: radial-gradient(circle at top right, rgba(207, 159, 114, 0.18), transparent 30%), var(--page);
          color: var(--ink);
          line-height: 1.58;
          font-size: 11pt;
        }

        main {
          background: var(--card);
          border: 1px solid var(--line);
          border-radius: 22px;
          padding: 28px 32px 36px;
        }

        h1,
        h2,
        h3,
        p,
        ul,
        ol,
        table,
        blockquote {
          margin-top: 0;
        }

        h1 {
          font-size: 24pt;
          line-height: 1.05;
          margin-bottom: 10px;
          letter-spacing: -0.04em;
        }

        h2 {
          margin-top: 22px;
          padding-top: 12px;
          border-top: 1px solid var(--line);
          color: var(--accent);
          font-size: 9.5pt;
          letter-spacing: 0.16em;
          text-transform: uppercase;
        }

        h3 {
          margin-bottom: 6px;
          font-size: 12pt;
          line-height: 1.35;
        }

        p,
        li,
        td,
        th {
          color: var(--muted);
        }

        strong {
          color: var(--ink);
        }

        blockquote {
          margin: 18px 0 22px;
          padding: 14px 16px;
          border-left: 4px solid var(--accent);
          background: rgba(123, 33, 51, 0.06);
          color: var(--ink);
          font-size: 11.3pt;
        }

        ul,
        ol {
          padding-left: 20px;
          margin-bottom: 14px;
        }

        li + li {
          margin-top: 4px;
        }

        table {
          width: 100%;
          border-collapse: collapse;
          margin-bottom: 16px;
          font-size: 10.5pt;
        }

        th,
        td {
          border-bottom: 1px solid var(--line);
          padding: 8px 10px;
          vertical-align: top;
          text-align: left;
        }

        th {
          color: var(--ink);
          font-size: 9pt;
          letter-spacing: 0.08em;
          text-transform: uppercase;
        }

        a {
          color: var(--accent);
          text-decoration: none;
        }

        hr {
          border: 0;
          border-top: 1px solid var(--line);
          margin: 20px 0;
        }
      </style>
    </head>
    <body>
      <main>${bodyHtml}</main>
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
