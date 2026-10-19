import { useMemo } from "react";
import type { NginxResult } from "../../nginx/types";
import { lookupCountry } from "../../nginx/countryLookup";
import { NginxBreakdownTable } from "./NginxBreakdowns";

export default function NginxClientsView({ result }: { result: NginxResult }) {
  const countries = useMemo(
    () => new Map(result.clients.map((row) => [row.value, lookupCountry(row.value)])),
    [result.clients],
  );
  return (
    <NginxBreakdownTable
      title="Clients"
      rows={result.clients}
      distinct={result.clientCount}
      total={result.summary.count}
      countries={countries}
    />
  );
}
