export type MachineIdentity = {
  host: string;
  user: string;
};

export function machineIdentity(hostname: string): MachineIdentity {
  const separator = hostname.indexOf("@");
  return separator === -1
    ? { user: hostname, host: hostname }
    : { user: hostname.slice(0, separator), host: hostname.slice(separator + 1) };
}
