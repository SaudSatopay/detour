"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useId, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { PaletteItem } from "@/lib/palette";
import { searchPalette } from "@/lib/palette-search";

const noSubscription = () => () => {};
const shortcut = () => (/Mac|iPhone|iPad/.test(navigator.userAgent) ? "⌘K" : "Ctrl K");
const noShortcut = () => null;

/** Go anywhere from the keyboard: a closure to run, a rider's trip, a page, a story chapter, a proof check. */
export function CommandPalette({ items }: { items: PaletteItem[] }) {
  const router = useRouter();
  const dialog = useRef<HTMLDialogElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const listId = useId();
  const keys = useSyncExternalStore(noSubscription, shortcut, noShortcut);
  const results = useMemo(() => searchPalette(items, query), [items, query]);

  const open = useCallback(() => {
    setQuery("");
    setActive(0);
    dialog.current?.showModal();
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        if (dialog.current?.open) dialog.current.close();
        else open();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  // Keep the active option in view as the arrows move it.
  useEffect(() => {
    list.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: "nearest" });
  }, [active, results]);

  const go = (item: PaletteItem) => {
    dialog.current?.close();
    router.push(item.href);
  };

  const onInputKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      setActive((a) => Math.min(results.length - 1, Math.max(0, a + (e.key === "ArrowDown" ? 1 : -1))));
    } else if (e.key === "Enter" && results[active]) {
      e.preventDefault();
      go(results[active]);
    }
  };

  // Groups in the order their best result appears.
  const groups: { name: PaletteItem["group"]; entries: { item: PaletteItem; index: number }[] }[] = [];
  results.forEach((item, index) => {
    const g = groups.find((x) => x.name === item.group) ?? groups[groups.push({ name: item.group, entries: [] }) - 1];
    g.entries.push({ item, index });
  });
  const optionId = (item: PaletteItem) => `${listId}-${item.id}`;

  return (
    <>
      <button
        type="button"
        onClick={open}
        aria-keyshortcuts="Control+K Meta+K"
        className="hidden shrink-0 items-center gap-2 rounded-sm border border-sign-ink/25 px-2.5 py-1 text-sign-ink/80 transition-colors duration-150 hover:border-sign-ink/60 hover:text-sign-ink sm:flex"
      >
        <svg viewBox="0 0 16 16" className="size-3.5" aria-hidden="true">
          <circle cx="7" cy="7" r="4.6" stroke="currentColor" strokeWidth="1.7" fill="none" />
          <path d="m10.5 10.5 3.6 3.6" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
        </svg>
        {/* The visible word starts the accessible name; the shortcut is announced through aria-keyshortcuts. */}
        <span className="label">Search</span>
        <span className="sr-only"> closures, riders and pages</span>
        {keys ? (
          <kbd aria-hidden="true" className="label rounded-sm bg-sign-ink/15 px-1 py-px text-xs">
            {keys}
          </kbd>
        ) : null}
      </button>

      <dialog
        ref={dialog}
        aria-label="Go to"
        onClick={(e) => e.target === dialog.current && dialog.current.close()}
        className="night m-auto mt-[12vh] w-[min(40rem,calc(100%-2rem))] max-w-none overflow-hidden rounded-lg border border-line p-0 shadow-lift backdrop:bg-sign/60"
      >
        <div className="sign-band sign-rule flex items-center gap-3 px-4 pb-3 pt-5">
          <svg viewBox="0 0 16 16" className="size-4 shrink-0 text-sign-ink/70" aria-hidden="true">
            <circle cx="7" cy="7" r="4.6" stroke="currentColor" strokeWidth="1.7" fill="none" />
            <path d="m10.5 10.5 3.6 3.6" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
          </svg>
          <input
            autoFocus
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setActive(0);
            }}
            onKeyDown={onInputKey}
            role="combobox"
            aria-expanded="true"
            aria-controls={listId}
            aria-autocomplete="list"
            aria-activedescendant={results[active] ? optionId(results[active]) : undefined}
            aria-label="Go to a closure, a rider, a page, a story chapter or a proof check"
            placeholder="A line, a rider, a page or a proof check"
            className="w-full min-w-0 bg-transparent font-display text-xl font-semibold text-sign-ink outline-none placeholder:font-normal placeholder:text-sign-ink/55"
          />
          <kbd className="label shrink-0 rounded-sm bg-sign-ink/15 px-1.5 py-px text-xs text-sign-ink/80">Esc</kbd>
        </div>
        <div ref={list} id={listId} role="listbox" aria-label="Places to go" className="max-h-[min(60vh,28rem)] overflow-y-auto p-2">
          {groups.map((g) => (
            <div key={g.name} role="group" aria-label={g.name}>
              <p aria-hidden="true" className="label px-3 pb-1 pt-3 text-ink-500">
                {g.name}
              </p>
              {g.entries.map(({ item, index }) => (
                <div
                  key={item.id}
                  id={optionId(item)}
                  role="option"
                  aria-selected={index === active}
                  onMouseMove={() => setActive(index)}
                  onClick={() => go(item)}
                  className={`flex min-w-0 cursor-pointer items-center gap-3 rounded-md px-3 py-2 transition-colors duration-100 ${index === active ? "bg-signal-wash text-ink-900" : "text-ink-700"}`}
                >
                  {item.colors ? (
                    <span className="flex shrink-0 gap-1.5" aria-hidden="true">
                      {item.colors.map((c) => (
                        <span key={c.route} className="flex items-center gap-1 font-display text-sm font-bold text-ink-900">
                          <span className="h-4 w-1.5 rounded-sm" style={{ backgroundColor: `#${c.hex}` }} />
                          {c.route}
                        </span>
                      ))}
                    </span>
                  ) : null}
                  <span className="shrink-0 font-display text-lg font-semibold">{item.label}</span>
                  {item.hint ? <span className="ml-auto min-w-0 truncate text-sm text-ink-500">{item.hint}</span> : null}
                </div>
              ))}
            </div>
          ))}
          {!results.length ? <p className="px-3 py-6 text-ink-500">Nothing matches. Try a line, a rider&apos;s name, a page or a proof check.</p> : null}
        </div>
      </dialog>
    </>
  );
}
