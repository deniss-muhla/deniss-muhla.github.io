import { useEffect, useState } from "react";

import styles from "./OfflineBadge.module.css";

/**
 * Small status pill shown while the browser is offline.
 * The app shell, fonts and voice models are served from cache in that state.
 */
export function OfflineBadge() {
  const [offline, setOffline] = useState(() => typeof navigator !== "undefined" && !navigator.onLine);

  useEffect(() => {
    const goOnline = () => setOffline(false);
    const goOffline = () => setOffline(true);

    window.addEventListener("online", goOnline);
    window.addEventListener("offline", goOffline);
    setOffline(!navigator.onLine);

    return () => {
      window.removeEventListener("online", goOnline);
      window.removeEventListener("offline", goOffline);
    };
  }, []);

  if (!offline) return null;

  return (
    <div className={styles.badge} role="status" aria-live="polite">
      <svg className={styles.icon} viewBox="0 0 24 24" aria-hidden="true">
        <path d="M2 8.8a15 15 0 0 1 6.2-3.6" />
        <path d="M15.8 5.2A15 15 0 0 1 22 8.8" />
        <path d="M5.5 12.2a10.5 10.5 0 0 1 3.6-1.9" />
        <path d="M14.9 10.3a10.5 10.5 0 0 1 3.6 1.9" />
        <path d="M9 15.6a5.5 5.5 0 0 1 2.3-1" />
        <path d="M13.7 14.9a5.5 5.5 0 0 1 1.3.7" />
        <path d="M12 19h.01" />
        <path d="M3 3l18 18" />
      </svg>
      <span className={styles.label}>Offline — cached content</span>
    </div>
  );
}
