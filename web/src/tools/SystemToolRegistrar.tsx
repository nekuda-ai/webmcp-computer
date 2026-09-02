import { useEffect } from "react";
import { useKernelStore } from "../kernel/store";
import { registerSystemTools } from "./registry";

export function SystemToolRegistrar() {
  useEffect(() => {
    const registration = registerSystemTools();
    let active = true;

    void registration.ready.then((results) => {
      if (!active) return;
      const statuses = results.map(({ name, state }) => ({ name, state }));
      useKernelStore.getState().setToolRegistrationStatuses(statuses);
      if (statuses.some(({ state }) => state !== "registered")) {
        console.warn("WebMCP Computer WebMCP tool registration incomplete", statuses);
      }
    });

    return () => {
      active = false;
      registration.unregister();
    };
  }, []);

  return null;
}
