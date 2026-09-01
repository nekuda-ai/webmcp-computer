import { lazy, type ComponentType, type SVGProps } from "react";
import { isSingletonApp, type AppId, type ProcessRecord } from "../kernel/types";
import {
  BrowserIcon,
  EditorIcon,
  FilesIcon,
  NotesIcon,
  PreviewIcon,
  SettingsIcon,
  TerminalIcon,
  UiIcon,
} from "./icons";

const FilesApp = lazy(async () => ({ default: (await import("./files/FilesApp")).FilesApp }));
const EditorApp = lazy(async () => ({ default: (await import("./editor/EditorApp")).EditorApp }));
const TerminalApp = lazy(async () => ({
  default: (await import("./terminal/TerminalApp")).TerminalApp,
}));
const NotesApp = lazy(async () => ({ default: (await import("./notes/NotesApp")).NotesApp }));
const PreviewApp = lazy(async () => ({
  default: (await import("./preview/PreviewApp")).PreviewApp,
}));
const SettingsApp = lazy(async () => ({
  default: (await import("./settings/SettingsApp")).SettingsApp,
}));
const UiApp = lazy(async () => ({ default: (await import("./ui/UiApp")).UiApp }));
const BrowserApp = lazy(async () => ({
  default: (await import("./browser/BrowserApp")).BrowserApp,
}));

export type AppComponentProps = {
  process: ProcessRecord;
};

export type AppDefinition = {
  id: AppId;
  name: string;
  icon: ComponentType<SVGProps<SVGSVGElement>>;
  component: ComponentType<AppComponentProps>;
  singleton: boolean;
};

function app(
  id: AppId,
  name: string,
  icon: AppDefinition["icon"],
  component: AppDefinition["component"],
): AppDefinition {
  return { id, name, icon, component, singleton: isSingletonApp(id) };
}

export const apps: readonly AppDefinition[] = [
  app("files", "Files", FilesIcon, FilesApp),
  app("editor", "Editor", EditorIcon, EditorApp),
  app("terminal", "Terminal", TerminalIcon, TerminalApp),
  app("notes", "Notes", NotesIcon, NotesApp),
  app("preview", "Preview", PreviewIcon, PreviewApp),
  app("settings", "Settings", SettingsIcon, SettingsApp),
  app("browser", "Browser", BrowserIcon, BrowserApp),
  app("ui", "App", UiIcon, UiApp),
];

export function getApp(appId: AppId): AppDefinition {
  const app = apps.find((candidate) => candidate.id === appId);
  if (!app) throw new Error(`verbos: unknown app '${appId}'`);
  return app;
}
