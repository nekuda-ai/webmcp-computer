import "@nekuda/webmcp-sdk";

declare module "@nekuda/webmcp-sdk" {
  interface ToolAnnotations {
    /** The tool can perform a consequential or irreversible action. */
    consequentialHint?: boolean;
  }
}
