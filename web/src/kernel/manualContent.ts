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
  "README.md": "f928e73abfc9913c2f4c05cbbd4c5171fe7c10902cda0676087de5dfc901f9c2",
  "apps.md": "37f3bebef6421e2bfb6a86bc218c10b1006116103c117ae46ce1def0597a63ea",
  "browser.md": "1ac6b36339bf88ba2fffd3ecd8e0be0ab4e0c59b78b163b53487137ecc92e857",
  "cloud.md": "9929d73763a6f297f1799efba8b0dd9d906970364ab85c71bc9fc78ba28aaa1d",
  "conventions.md": "1f4e5be4b219f3e0a5369e439a7f2477e814bca86188615f955188f84f2b7d2a",
  "filesystem.md": "081d2e4655d8b70a51611bd49f6cf629936d27a986dcc7e30299acf1f70e2113",
  "preview.md": "91744db371a3aa17d1763d708b1e1f63f3d3e5306100fc64cbeb9bcb03cc45b4",
  "terminal.md": "c9cd83702f234905cb32b3f53d434850cfeff470e2b528252022a5628e144149",
  "windows.md": "b080165ef320039446c68fcc110e0c7477e75305acedc4b9c92a87260dc80c51",
} as const;
