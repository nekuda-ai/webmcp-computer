import readme from "../../../docs/agent-skills/README.md?raw";
import apps from "../../../docs/agent-skills/apps.md?raw";
import browser from "../../../docs/agent-skills/browser.md?raw";
import cloud from "../../../docs/agent-skills/cloud.md?raw";
import conventions from "../../../docs/agent-skills/conventions.md?raw";
import filesystem from "../../../docs/agent-skills/filesystem.md?raw";
import preview from "../../../docs/agent-skills/preview.md?raw";
import terminal from "../../../docs/agent-skills/terminal.md?raw";
import windows from "../../../docs/agent-skills/windows.md?raw";

export const AGENT_SKILL_FILES = {
  "README.md": readme,
  "apps.md": apps,
  "browser.md": browser,
  "cloud.md": cloud,
  "filesystem.md": filesystem,
  "terminal.md": terminal,
  "windows.md": windows,
  "preview.md": preview,
  "conventions.md": conventions,
} as const;

// Intentional review pin: changing shipped manual bytes requires updating this map.
export const AGENT_SKILL_SHA256 = {
  "README.md": "4cbb848863f3aa0c997cfc1d42fde34c9cbed8fbdc9bc27cbc9d5e610257ad61",
  "apps.md": "37f3bebef6421e2bfb6a86bc218c10b1006116103c117ae46ce1def0597a63ea",
  "browser.md": "f4f15d1fe6b5b00ee1cf85de8612e9aecc3274771252a49649daba435fd28147",
  "cloud.md": "9929d73763a6f297f1799efba8b0dd9d906970364ab85c71bc9fc78ba28aaa1d",
  "conventions.md": "103b28b4cfa1f62d259880f445c6269df13f8a7fec448d5d1f3ff50f36836dbd",
  "filesystem.md": "081d2e4655d8b70a51611bd49f6cf629936d27a986dcc7e30299acf1f70e2113",
  "preview.md": "91744db371a3aa17d1763d708b1e1f63f3d3e5306100fc64cbeb9bcb03cc45b4",
  "terminal.md": "c9cd83702f234905cb32b3f53d434850cfeff470e2b528252022a5628e144149",
  "windows.md": "e0604e5076e4217b34f5f5a718ef52ab915050af5432431aef83100625dac8a5",
} as const;
