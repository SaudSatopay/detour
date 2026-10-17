import { TrimLine } from "./trim-line";

export function SiteFooter() {
  return (
    <footer>
      <TrimLine />
      <div className="mx-auto flex max-w-page flex-col gap-2 px-4 py-6 text-sm text-ink-500 sm:flex-row sm:items-center sm:justify-between sm:px-6">
        <p>
          Built on MTA open data (GTFS, station complexes, 2025 origin-destination ridership). Not affiliated with the MTA. Riders and past
          incidents are example data.
        </p>
        <p className="shrink-0">
          Graph by <a className="underline decoration-line-strong underline-offset-4 hover:text-ink-900" href="https://www.falkordb.com">FalkorDB</a> · Built for{" "}
          <a className="underline decoration-line-strong underline-offset-4 hover:text-ink-900" href="https://www.wemakedevs.org/hackathons/falkordb">
            Graph Hacks
          </a>
        </p>
      </div>
    </footer>
  );
}
