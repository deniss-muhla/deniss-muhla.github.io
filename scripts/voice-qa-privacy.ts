export function qaUrl(baseUrl: string, redacted: boolean): string {
  if (!redacted) return baseUrl;
  const url = new URL(baseUrl);
  url.searchParams.delete("voiceDebug");
  return url.toString();
}

export function logQaContent(
  redacted: boolean,
  logger: (...values: unknown[]) => void,
  ...values: unknown[]
): void {
  if (!redacted) logger(...values);
}

export async function takeQaScreenshot(
  page: { screenshot: (options: { path: string }) => Promise<unknown> },
  path: string,
  redacted: boolean,
): Promise<void> {
  if (!redacted) await page.screenshot({ path });
}

export function logQaError(
  error: unknown,
  redacted: boolean,
  logger: (...values: unknown[]) => void,
): void {
  if (redacted) {
    logger("[qa] failed (details redacted)");
  } else {
    logger("[qa] failed:", error instanceof Error ? error.message : error);
  }
}
