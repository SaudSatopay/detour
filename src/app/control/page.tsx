import type { Metadata } from "next";
import scenarios from "../../../data/scenarios.json";
import { ControlRoom } from "@/components/control/control-room";

export const metadata: Metadata = {
  title: "Control room",
  description: "Close a subway line in your own copy of the graph and watch the agents measure who it hits, what the network can carry, and which plan fixes it.",
};

/** Static: the room reads ?scenario and ?run on the client, so the first paint is the full intake, not a placeholder. */
export default function ControlPage() {
  return <ControlRoom scenarios={scenarios} />;
}
