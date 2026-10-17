import map from "../../public/map/nyc.json";

/** Route colors from GTFS (data, not brand tokens), one per trunk line, in the order riders know them. */
const TRUNKS = ["1", "4", "7", "A", "B", "G", "J", "L", "N", "S"];
const COLOR = new Map(map.routes.map((r) => [r[0] as string, r[2] as string]));

/** The colored tile band along a station wall: a section divider, never more than one per screen. */
export function TrimLine({ className = "" }: { className?: string }) {
  return (
    <div aria-hidden="true" className={`flex h-1.5 w-full ${className}`}>
      {TRUNKS.map((id) => (
        <span key={id} className="flex-1" style={{ backgroundColor: `#${COLOR.get(id) ?? "808183"}` }} />
      ))}
    </div>
  );
}
