"use client";

import { useEffect, useState } from "react";

/**
 * False until the page has loaded and the browser has gone idle: for work that should never compete with the
 * first paint, such as the story map or opening the faces a control-room run will use.
 */
export function useAfterLoad(timeout = 1200): boolean {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    let idle = 0;
    let timer = 0;
    const arm = () => {
      if (typeof window.requestIdleCallback === "function") idle = window.requestIdleCallback(() => setReady(true), { timeout });
      else timer = window.setTimeout(() => setReady(true), 200);
    };
    if (document.readyState === "complete") arm();
    else window.addEventListener("load", arm, { once: true });
    return () => {
      window.removeEventListener("load", arm);
      if (idle) window.cancelIdleCallback(idle);
      if (timer) window.clearTimeout(timer);
    };
  }, [timeout]);
  return ready;
}
