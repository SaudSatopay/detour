import { describe, expect, it } from "vitest";
import {
  linesOf,
  nyStamp,
  outageKey,
  parseMtaDate,
  parseSnapshot,
  parseSodaDate,
  projectRoutes,
  quarterOf,
  recordUrl,
  routeId,
  stationFromLocation,
  trimAlert,
  type AgencySnapshot,
  type RawEquipment,
  type RawOutage,
} from "./agency-feeds";

const known = new Set(["A", "C", "E", "B", "Q", "FS", "GS", "L", "6", "7", "F", "SI"]);
const stations = [
  { id: "119", name: "1 Av", routes: ["L"] },
  { id: "33", name: "Prospect Park", routes: ["B", "Q", "FS"] },
  { id: "611", name: "42 St-Port Authority Bus Terminal", routes: ["A", "C", "E"] },
  { id: "167", name: "Hoyt-Schermerhorn Sts", routes: ["A", "C", "G"] },
  { id: "21", name: "14 St", routes: ["F", "M"] },
  { id: "601", name: "14 St", routes: ["A", "C", "E"] },
];

describe("times", () => {
  it("reads the elevator feeds' New York times, in summer and in winter", () => {
    expect(new Date(parseMtaDate("10/30/2026 10:00:00 PM")!).toISOString()).toBe("2026-10-31T02:00:00.000Z");
    expect(new Date(parseMtaDate("12/01/2026 06:00:00 AM")!).toISOString()).toBe("2026-12-01T11:00:00.000Z");
    expect(new Date(parseMtaDate("10/31/2026 12:00:00 AM")!).toISOString()).toBe("2026-10-31T04:00:00.000Z");
    expect(parseMtaDate("")).toBeNull();
    expect(parseMtaDate("soon")).toBeNull();
  });
  it("reads data.ny.gov floating timestamps as New York time and writes them back the same way", () => {
    const ms = parseSodaDate("2026-08-11T23:51:00.000")!;
    expect(new Date(ms).toISOString()).toBe("2026-08-12T03:51:00.000Z");
    expect(nyStamp(ms)).toBe("2026-08-11 23:51");
    expect(quarterOf(ms)).toBe("2026 Q3");
    expect(quarterOf(parseSodaDate("2025-01-01")!)).toBe("2025 Q1");
  });
});

describe("lines and stations", () => {
  it("folds express variants into their line", () => {
    expect(routeId("6X", known)).toBe("6");
    expect(routeId("SIR", known)).toBe("SI");
    expect(routeId("K", known)).toBeNull();
  });
  it("reads a unit's lines, with S as the shuttle stopping at its station", () => {
    expect(linesOf("B/Q/S", stations[1], known)).toEqual(["B", "Q", "FS"]);
    expect(linesOf("A/C/E", stations[2], known)).toEqual(["A", "C", "E"]);
  });
  it("finds the station a complaint names, by its name and its lines", () => {
    expect(stationFromLocation("Hoyt-Schermerhorn (A,C,G) Brooklyn", stations, known)).toBe("167");
    expect(stationFromLocation("14 St (A,C,E) Manhattan", stations, known)).toBe("601");
    expect(stationFromLocation("Nowhere Av (Z) Queens", stations, known)).toBeNull();
  });
  it("reads a project's lines and drops other agencies'", () => {
    expect(projectRoutes("['NYCT-B', 'NYCT-QN', 'MNR-1', 'NYCT-SIR']", known)).toEqual(["B", "SI"]);
  });
});

describe("records", () => {
  it("keeps an alert's English text, periods, routes and stops", () => {
    const a = trimAlert({
      id: "lmm:alert:1",
      alert: {
        active_period: [{ start: 100, end: 200 }],
        informed_entity: [{ route_id: "A", stop_id: "A27" }],
        header_text: { translation: [{ text: "<p>x</p>", language: "en-html" }, { text: "Delays on the A", language: "en" }] },
        "transit_realtime.mercury_alert": { created_at: 90, alert_type: "Delays" },
      },
    });
    expect(a).toEqual({ id: "lmm:alert:1", periods: [{ start: 100, end: 200 }], entities: [{ route: "A", stop: "A27" }], header: "Delays on the A", description: null, type: "Delays", createdAt: 90, updatedAt: null });
    expect(trimAlert({ id: "x", alert: {} })).toBeNull();
  });
  it("keys an outage by its unit and start, and links records to a URL that returns them", () => {
    expect(outageKey("EL382", parseMtaDate("10/30/2026 10:00:00 PM"))).toBe("EL382@2026-10-30 22:00");
    expect(recordUrl("94fv-bak7", "EL382")).toBe("https://data.ny.gov/resource/94fv-bak7.json?equipment_code=EL382");
  });
});

const unit = (over: Partial<RawEquipment>): RawEquipment => ({
  station: "Prospect Park",
  borough: "",
  trainno: "B/Q/S",
  equipmentno: "EL382",
  equipmenttype: "EL",
  serving: "street to platform",
  ADA: "Y",
  isactive: "Y",
  nonNYCT: "N",
  shortdescription: "Street to platform",
  linesservedbyelevator: "B/Q/S",
  elevatorsgtfsstopid: "D26",
  elevatormrn: "33",
  stationcomplexid: "33",
  nextadanorth: "",
  nextadasouth: "",
  redundant: 0,
  busconnections: "",
  alternativeroute: "Take a B or Q to Church Av.",
  ...over,
});

const outage = (over: Partial<RawOutage>): RawOutage => ({
  station: "Prospect Park",
  borough: "",
  trainno: "B/Q/S",
  equipment: "EL382",
  equipmenttype: "EL",
  serving: "street to platform",
  ADA: "Y",
  outagedate: "10/18/2026 03:36:00 PM",
  estimatedreturntoservice: "10/31/2026 06:00:00 AM",
  reason: "Repair",
  isupcomingoutage: "N",
  ismaintenanceoutage: "N",
  ...over,
});

const tinySnapshot = (): AgencySnapshot => ({
  version: 1,
  fetched: { "mta-ene-equipment": 1000, "94fv-bak7": 900, "7kct-peq7": 800, "nh7m-at3e": 700, "9hy6-8j6t": 600, "nswv-d6bz": 600 },
  equipment: [unit({}), unit({ equipmentno: "EL293", station: "1 Av", trainno: "L", linesservedbyelevator: "L", stationcomplexid: "119", alternativeroute: "" })],
  outageCaptures: [
    { fetchedMs: 1000, outages: [outage({}), outage({ equipment: "EL293", station: "1 Av", trainno: "L", outagedate: "10/17/2026 09:00:00 AM" })] },
    { fetchedMs: 2000, outages: [outage({})] },
  ],
  upcoming: [outage({ outagedate: "10/30/2026 10:00:00 PM", isupcomingoutage: "Y" })],
  alerts: { fetchedMs: 2000, feedMs: 1990, alerts: [{ id: "lmm:alert:9", periods: [{ start: 10 }], entities: [{ route: "6X" }, { route: "L", stop: "L06N" }], header: "Delays", description: null, type: "Delays", createdAt: 5, updatedAt: 6 }] },
  stops: { L06: "119" },
  assets: [
    { equipment_code: "EL382", maintained_by: "NYCT", installer: "KONE", station_complex_mrn: "33", service_status: "Installed-Functioning-In Service" },
    { equipment_code: "ES999X", maintained_by: "Private Contractor", station_complex_mrn: "611", elevator_or_escalator: "Escalator", notes: "atrium to mezzanine" },
  ],
  notices: [
    { alert_id: "2", event_id: "77", update_number: "1", date: "2026-08-11T23:51:00.000", status_label: "delays", affected: "Q", header: "Q delayed, moving" },
    { alert_id: "1", event_id: "77", update_number: "0", date: "2026-08-11T23:34:00.000", status_label: "delays", affected: "Q", header: "Q delayed" },
  ],
  complaints: [
    { location_name: "Hoyt-Schermerhorn (A,C,G) Brooklyn", month: "2026-01-01T00:00:00.000", n: "2" },
    { location_name: "Hoyt-Schermerhorn (A,C,G) Brooklyn", month: "2026-02-01T00:00:00.000", n: "3" },
  ],
  projects: [{ project_id: "8356", title: "ADA at 1 Av", stage: "Construction", services: "['NYCT-L']" }],
  milestones: [{ project_id: "8356", phase: "Procurement", phase_sequence: "2", phase_state: "Complete", activity_title: "Contract Solicitation", activity_date: "2018-06-01T00:00:00.000" }],
});

describe("parseSnapshot", () => {
  const r = parseSnapshot(tinySnapshot(), { stations, routes: [...known] });

  it("joins each unit to its station, lines and asset inventory line, and adds units only the inventory lists", () => {
    const el = r.equipment.find((e) => e.id === "EL382")!;
    expect(el).toMatchObject({ station: "33", lines: ["B", "Q", "FS"], maintainedBy: "NYCT", installer: "KONE", altRoute: "Take a B or Q to Church Av." });
    expect(el.prov).toMatchObject({ dataset: "mta-ene-equipment", record: "EL382", fetchedMs: 1000 });
    expect(el.asset?.url).toContain("equipment_code=EL382");
    expect(r.equipment.find((e) => e.id === "EL293")!.altRoute).toBeNull();
    expect(r.equipment.find((e) => e.id === "ES999X")).toMatchObject({ kind: "escalator", station: "611", maintainedBy: "Private Contractor", stationName: "42 St-Port Authority Bus Terminal" });
  });
  it("keeps every outage capture and adds the planned outages to the newest", () => {
    expect(r.outageCaptures.map((c) => c.outages.map((o) => o.id))).toEqual([["EL382@2026-10-18 15:36", "EL293@2026-10-17 09:00"], ["EL382@2026-10-18 15:36", "EL382@2026-10-30 22:00"]]);
    const o = r.outageCaptures[1].outages[0];
    expect(o).toMatchObject({ station: "33", lines: ["B", "Q", "FS"], reason: "Repair", upcoming: false });
    expect(o.quote).toContain("estimatedreturntoservice: 10/31/2026 06:00:00 AM");
    expect(r.outageCaptures[1].outages[1].upcoming).toBe(true);
  });
  it("maps an alert's routes and stops to Detour's lines and station complexes", () => {
    expect(r.alerts[0]).toMatchObject({ routes: ["6", "L"], stations: ["119"], startMs: 10_000, endMs: null });
  });
  it("chains archived alert updates into events, in update order", () => {
    expect(r.events).toEqual([expect.objectContaining({ id: "EV-77", updates: 2, firstHeader: "Q delayed", lastHeader: "Q delayed, moving", routes: ["Q"] })]);
  });
  it("sums complaints by station and quarter", () => {
    expect(r.complaints).toEqual([expect.objectContaining({ station: "167", quarter: "2026 Q1", count: 5 })]);
  });
  it("links projects to lines and their milestones to the project", () => {
    expect(r.projects[0]).toMatchObject({ id: "CP-8356", routes: ["L"], stations: [], stage: "Construction" });
    expect(r.milestones[0]).toMatchObject({ id: "CP-8356-2-1", project: "CP-8356", title: "Contract Solicitation" });
  });
});
