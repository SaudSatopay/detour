"use client";

import { RouteError } from "@/components/route-error";

export default function Error({ retry }: { error: unknown; retry: () => void }) {
  return <RouteError where="agency brain" retry={retry} />;
}
