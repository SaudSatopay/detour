import { describe, expect, it } from "vitest";
import { extractMentions, platformRoute } from "./intake";

const STATIONS = [
  { id: "636", name: "Jay St-MetroTech", routes: ["A", "C", "F", "R"] },
  { id: "630", name: "Myrtle-Wyckoff Avs", routes: ["M", "L"] },
  { id: "602", name: "14 St-Union Sq", routes: ["L", "N", "Q", "R", "W", "4", "5", "6"] },
  { id: "X1", name: "14 St", routes: ["1", "2", "3"] },
  { id: "X2", name: "14 St", routes: ["F", "M"] },
  { id: "629", name: "Metropolitan Av/Lorimer St", routes: ["G", "L"] },
  { id: "M1", name: "Middle Village-Metropolitan Av", routes: ["M"] },
  { id: "H1", name: "Howard Beach-JFK Airport", routes: ["A"] },
];
const ROUTES = ["A", "C", "F", "R", "M", "L", "N", "Q", "W", "G", "1", "2", "3", "4", "5", "6"];
const PEOPLE = [
  { id: "P-MENDEZ", name: "Gloria Méndez" },
  { id: "P-RAMAN", name: "Priya Raman" },
];
const read = (text: string) => extractMentions(text, STATIONS, ROUTES, PEOPLE);

describe("extractMentions", () => {
  it("finds an elevator outage, its station and its platform", () => {
    const m = read("Elevator to the A platform at Jay St-MetroTech is stuck between floors.");
    expect(m.stations.map((s) => s.id)).toEqual(["636"]);
    expect(m.routes).toEqual(["A"]);
    expect(m.outage).toBe("elevator");
    expect(m.restored).toBe(false);
    expect(platformRoute(m.stations[0], m.routes)).toBe("A");
  });
  it("reads a fix, and a station written without its street type", () => {
    const m = read("Myrtle-Wyckoff L platform elevator is back in service: the motor controller was replaced.");
    expect(m.stations.map((s) => s.id)).toEqual(["630"]);
    expect(m.outage).toBeNull();
    expect(m.restored).toBe(true);
    expect(platformRoute(m.stations[0], m.routes)).toBe("L");
  });
  it("prefers the longest name, so 14 St inside 14 St-Union Sq does not count", () => {
    const m = read("The elevator to the L at 14 St-Union Sq is out of service again.");
    expect(m.stations.map((s) => s.id)).toEqual(["602"]);
    expect(m.outage).toBe("elevator");
  });
  it("resolves a shared name by the line the text names, or leaves it out", () => {
    expect(read("The G at Metropolitan is packed.").stations.map((s) => s.id)).toEqual(["629"]);
    expect(read("Crowds at Metropolitan this morning.").stations).toEqual([]);
  });
  it("names agency people by full name or a unique first name", () => {
    expect(read("Priya Raman wants two more G trains; ask Gloria about the elevator.").people).toEqual(["P-MENDEZ", "P-RAMAN"]);
  });
  it("needs an outage word before it calls something an outage", () => {
    expect(read("Who owns the Myrtle-Wyckoff elevator outage?").outage).toBe("elevator");
    expect(read("Is the Jay St-MetroTech elevator ok?").outage).toBeNull();
  });
});
