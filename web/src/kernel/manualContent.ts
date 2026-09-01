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
  "README.md": "d2bef8d10d3e51f2e652b2a0756f0ab0d4c2f193f6d65df21364f0825ff40625",
  "apps.md": "6dc336a39b8b7ed36123b71087054250d1b1f9495b1f8364de3f53ed55e78657",
  "browser.md": "eff2c30a8aabdfe5661d457085526acbabce4bf15d4c621cc7210eef27330c3d",
  "cloud.md": "fdbc019861e6129beaa15c5a52d1411e50f47ffd33174d809fbd5f9573c05cd9",
  "conventions.md": "f5512a38e082e98611a53af47912ebf5fc362e06b38d4d6426e390bc27f49e0f",
  "filesystem.md": "d4b4c50272f60ff68b2b9862c7e53d180717ac1a1c55aaba119a89b5395a2bbe",
  "preview.md": "59c11bf05bac00ab193fcaff85dfe9b6d5df9e35b2ed3c7479cbe8a195f67bb6",
  "terminal.md": "bce24ac1da8da0c0d90985d6e7ba1a353bc30d8df3677ed58ffd635d943de819",
  "windows.md": "c0fdf102caffb42fc4070fcddb2d6cd8518ff95164f4b071c2148da53d32b0af",
} as const;
