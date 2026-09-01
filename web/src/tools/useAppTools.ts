import { useEffect } from "react";
import type { AnyWebMCPTool } from "@nekuda/webmcp-sdk";
import { registerAppTools } from "./registry";

export function shouldWarnAppToolRegistration(
  active: boolean,
  results: ReadonlyArray<{ state: string }>,
): boolean {
  return active && results.some(({ state }) => state !== "registered");
}

export function useAppTools(pid: number, tools: readonly AnyWebMCPTool[]): void {
  useEffect(() => {
    let active = true;
    const registration = registerAppTools(pid, tools);
    void registration.ready.then((results) => {
      if (shouldWarnAppToolRegistration(active, results)) {
        console.warn(`VerbOS PID ${pid} WebMCP tool registration incomplete`, results);
      }
    });
    return () => {
      active = false;
      registration.unregister();
    };
  }, [pid, tools]);
}
