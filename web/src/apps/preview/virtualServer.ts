import { ls, readFileBytes } from "../../kernel/fs";
import { createSiteModelContextFacade } from "./siteToolBridge";
import { installFrameConsoleCapture } from "../frame/frameConsole";

export type PreviewVirtualFile = {
  path: string;
  contentType: string;
  body: Uint8Array;
};

export type SelfContainedDocument = {
  html: string;
  warnings: string[];
};

export const MAX_PREVIEW_DOCUMENT_BYTES = 8 * 1024 * 1024;
const PREVIEW_DOCUMENT_OVERHEAD_BYTES = 64 * 1024;

const contentTypes: Record<string, string> = {
  css: "text/css; charset=utf-8",
  gif: "image/gif",
  html: "text/html; charset=utf-8",
  htm: "text/html; charset=utf-8",
  ico: "image/x-icon",
  jpeg: "image/jpeg",
  jpg: "image/jpeg",
  js: "text/javascript; charset=utf-8",
  json: "application/json; charset=utf-8",
  mjs: "text/javascript; charset=utf-8",
  png: "image/png",
  svg: "image/svg+xml; charset=utf-8",
  txt: "text/plain; charset=utf-8",
  webp: "image/webp",
};

function contentType(path: string): string {
  const extension = path.split(".").at(-1)?.toLowerCase() ?? "";
  return contentTypes[extension] ?? "application/octet-stream";
}

function scriptJson(value: unknown): string {
  return JSON.stringify(value).replaceAll("<", "\\u003c");
}

export function injectPreviewBridge(
  html: string,
  pid: number,
  token: string,
  warnings: readonly string[] = [],
): string {
  const bridge = `<script>(()=>{const marker=${scriptJson(token)};const post=(message)=>parent.postMessage({__webmcpComputerPreview:true,pid:${pid},token:marker,...message},'*');const listeners=[];const createFacade=(${createSiteModelContextFacade.toString()});const installConsole=(${installFrameConsoleCapture.toString()});const facade=createFacade(post,(listener)=>listeners.push(listener));Object.defineProperty(document,'modelContext',{configurable:true,value:facade});window.addEventListener('message',(event)=>{const message=event.data;if(event.source!==parent||message?.__webmcpComputerPreview!==true||message.pid!==${pid}||message.token!==marker)return;if(message.kind==='site-tool-registration'||message.kind==='site-tool-call')for(const listener of listeners)listener(message)});installConsole((level,message)=>post({level,message}));for(const warning of ${scriptJson(warnings)})console.warn(warning);document.addEventListener('click',(event)=>{const target=event.target;if(!(target instanceof Element))return;const anchor=target.closest('a[href]');const href=anchor?.getAttribute('href');if(!href||href.startsWith('#')||href.startsWith('//')||/^[a-z][a-z0-9+.-]*:/i.test(href))return;event.preventDefault();console.warn('webmcp-computer-preview: internal navigation unavailable: '+href)})})();</script>`;
  const head = /<head(?:\s[^>]*)?>/i;
  return head.test(html) ? html.replace(head, (match) => `${match}${bridge}`) : `${bridge}${html}`;
}

async function collectDirectory(
  root: string,
  directory: string,
  files: PreviewVirtualFile[],
): Promise<void> {
  for (const entry of await ls(directory)) {
    if (entry.kind === "directory") {
      await collectDirectory(root, entry.path, files);
      continue;
    }
    const relativePath = entry.path.slice(root.length).replace(/^\//, "");
    files.push({
      path: relativePath,
      contentType: contentType(relativePath),
      body: await readFileBytes(entry.path),
    });
  }
}

export async function collectPreviewFiles(root: string): Promise<PreviewVirtualFile[]> {
  const files: PreviewVirtualFile[] = [];
  await collectDirectory(root, root, files);
  if (!files.some(({ path }) => path === "index.html")) {
    throw new Error(`webmcp-computer: preview root has no index.html: ${root}`);
  }
  return files;
}

function directoryOf(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash === -1 ? "" : path.slice(0, slash + 1);
}

type ResolvedReference =
  | { kind: "external" }
  | { kind: "escape" }
  | { kind: "local"; path: string; suffix: string };

function resolveReference(fromPath: string, reference: string): ResolvedReference {
  if (
    reference === "" ||
    reference.startsWith("#") ||
    reference.startsWith("//") ||
    /^[a-z][a-z0-9+.-]*:/i.test(reference)
  ) {
    return { kind: "external" };
  }

  const suffixIndex = reference.search(/[?#]/);
  const path = suffixIndex === -1 ? reference : reference.slice(0, suffixIndex);
  const suffix = suffixIndex === -1 ? "" : reference.slice(suffixIndex);
  if (path === "") return { kind: "external" };
  const parts = (path.startsWith("/") ? path.slice(1) : `${directoryOf(fromPath)}${path}`).split("/");
  const normalized: string[] = [];
  for (const part of parts) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (normalized.length === 0) return { kind: "escape" };
      normalized.pop();
    } else {
      normalized.push(part);
    }
  }
  const result = normalized.join("/");
  return {
    kind: "local",
    path: path.endsWith("/") || result === "" ? `${result}${result === "" ? "" : "/"}index.html` : result,
    suffix,
  };
}

function base64(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

function dataUri(file: PreviewVirtualFile, body = file.body): string {
  return `data:${file.contentType.replaceAll(" ", "")};base64,${base64(body)}`;
}

function estimatedDataUriBytes(file: PreviewVirtualFile): number {
  const prefix = `data:${file.contentType.replaceAll(" ", "")};base64,`;
  return new TextEncoder().encode(prefix).byteLength + 4 * Math.ceil(file.body.byteLength / 3);
}

type RewriteContext = {
  files: ReadonlyMap<string, PreviewVirtualFile>;
  warnings: Set<string>;
  assetUris: Map<string, string>;
  cssImportUris: Map<string, string>;
  includedCssImports: Set<string>;
  visitingCssImports: Set<string>;
  moduleBodies: Map<string, string>;
  moduleSpecifiers: Map<string, string>;
  moduleUris: Map<string, string>;
  remainingAssetBytes: number;
  budgetDroppedAssets: Set<string>;
};

function createRewriteContext(
  files: ReadonlyMap<string, PreviewVirtualFile>,
  warnings: Set<string>,
  remainingAssetBytes: number,
): RewriteContext {
  return {
    files,
    warnings,
    assetUris: new Map(),
    cssImportUris: new Map(),
    includedCssImports: new Set(),
    visitingCssImports: new Set(),
    moduleBodies: new Map(),
    moduleSpecifiers: new Map(),
    moduleUris: new Map(),
    remainingAssetBytes,
    budgetDroppedAssets: new Set(),
  };
}

function cachedAssetUri(context: RewriteContext, file: PreviewVirtualFile): string {
  const cached = context.assetUris.get(file.path);
  if (cached !== undefined) return cached;
  const uri = dataUri(file);
  context.assetUris.set(file.path, uri);
  return uri;
}

function warnMissing(warnings: Set<string>, reference: string): void {
  warnings.add(`webmcp-computer-preview: missing asset: ${reference}`);
}

function warnOutside(warnings: Set<string>, reference: string): void {
  warnings.add(`webmcp-computer-preview: outside the served root: ${reference}`);
}

function warnBudget(context: RewriteContext, path: string): void {
  context.budgetDroppedAssets.add(path);
  context.warnings.add(`webmcp-computer-preview: asset dropped (budget): ${path}`);
}

function inlineAssetReference(
  fromPath: string,
  reference: string,
  context: RewriteContext,
): string {
  const resolved = resolveReference(fromPath, reference);
  if (resolved.kind === "external") return reference;
  if (resolved.kind === "escape") {
    warnOutside(context.warnings, reference);
    return reference;
  }
  const file = context.files.get(resolved.path);
  if (!file) {
    warnMissing(context.warnings, reference);
    return reference;
  }
  const uriBytes = estimatedDataUriBytes(file) +
    new TextEncoder().encode(resolved.suffix).byteLength;
  if (uriBytes > context.remainingAssetBytes) {
    warnBudget(context, resolved.path);
    return reference;
  }
  const uri = `${cachedAssetUri(context, file)}${resolved.suffix}`;
  context.remainingAssetBytes -= uriBytes;
  return uri;
}

function rewriteCss(
  path: string,
  css: string,
  context: RewriteContext,
): string {
  const rewriteImport = (original: string, reference: string, qualifier: string): string => {
    const resolved = resolveReference(path, reference);
    if (resolved.kind === "external") return original;
    if (resolved.kind === "escape") {
      warnOutside(context.warnings, reference);
      return original;
    }
    const file = context.files.get(resolved.path);
    if (!file) {
      warnMissing(context.warnings, reference);
      return original;
    }
    if (context.visitingCssImports.has(resolved.path)) {
      context.warnings.add(`webmcp-computer-preview: cyclic stylesheet import: ${reference}`);
      return original;
    }
    if (context.includedCssImports.has(resolved.path)) return "";
    context.includedCssImports.add(resolved.path);
    let uri = context.cssImportUris.get(resolved.path);
    if (uri === undefined) {
      context.visitingCssImports.add(resolved.path);
      const imported = rewriteCss(
        resolved.path,
        new TextDecoder().decode(file.body),
        context,
      );
      context.visitingCssImports.delete(resolved.path);
      uri = dataUri(file, new TextEncoder().encode(imported));
      context.cssImportUris.set(resolved.path, uri);
    }
    return `@import url("${uri}${resolved.suffix}")${qualifier};`;
  };

  const imports = css
    .replace(
      /@import\s+url\(\s*(?:(["'])([^"']+)\1|([^\s)"']+))\s*\)([^;]*);/gi,
      (original, _quote: string | undefined, quoted: string | undefined, bare: string | undefined, qualifier: string) =>
        rewriteImport(original, quoted ?? bare ?? "", qualifier),
    )
    .replace(
      /@import\s+(["'])([^"']+)\1([^;]*);/gi,
      (original, _quote: string, reference: string, qualifier: string) =>
        rewriteImport(original, reference, qualifier),
    );

  return imports.replace(
    /url\(\s*(["']?)([^"')]+)\1\s*\)/gi,
    (_match, quote: string, reference: string) =>
      `url(${quote}${inlineAssetReference(path, reference, context)}${quote})`,
  );
}

function moduleSpecifier(path: string, suffix: string): string {
  return `webmcp-computer-module:${encodeURIComponent(path)}${suffix}`;
}

function registerModule(path: string, suffix: string, context: RewriteContext): string {
  const specifier = moduleSpecifier(path, suffix);
  context.moduleSpecifiers.set(specifier, path);
  if (context.moduleBodies.has(path)) return specifier;
  const file = context.files.get(path);
  if (!file) return specifier;
  context.moduleBodies.set(path, "");
  context.moduleBodies.set(
    path,
    rewriteJavaScript(path, new TextDecoder().decode(file.body), context),
  );
  return specifier;
}

function rewriteJavaScript(
  path: string,
  code: string,
  context: RewriteContext,
): string {
  return code.replace(
    /(\b(?:from|import)\s*(?:\(\s*)?)(["'])([^"']+)\2/g,
    (original, prefix: string, quote: string, reference: string) => {
      const resolved = resolveReference(path, reference);
      if (resolved.kind === "external") return original;
      if (resolved.kind === "escape") {
        warnOutside(context.warnings, reference);
        return original;
      }
      const file = context.files.get(resolved.path);
      if (!file) {
        warnMissing(context.warnings, reference);
        return original;
      }
      const specifier = registerModule(resolved.path, resolved.suffix, context);
      return `${prefix}${quote}${specifier}${quote}`;
    },
  );
}

const htmlEntities: Record<string, string> = {
  amp: "&",
  apos: "'",
  gt: ">",
  lt: "<",
  quot: '"',
};

function decodeAttribute(value: string): string {
  return value.replace(/&(#x[\da-f]+|#\d+|amp|apos|gt|lt|quot);/gi, (entity, name: string) => {
    if (name[0] !== "#") return htmlEntities[name.toLowerCase()] ?? entity;
    const hexadecimal = name[1]?.toLowerCase() === "x";
    const point = Number.parseInt(name.slice(hexadecimal ? 2 : 1), hexadecimal ? 16 : 10);
    return Number.isInteger(point) && point >= 0 && point <= 0x10ffff
      ? String.fromCodePoint(point)
      : entity;
  });
}

function attributeValue(attributes: string, name: string): string | undefined {
  const match = attributes.match(new RegExp(`\\b${name}\\s*=\\s*(["'])([^"']*)\\1`, "i"));
  return match?.[2] === undefined ? undefined : decodeAttribute(match[2]);
}

function removeAttribute(attributes: string, name: string): string {
  return attributes.replace(new RegExp(`\\s+${name}\\s*=\\s*(["'])[^"']*\\1`, "i"), "");
}

function escapeAttribute(value: string, quote = '"'): string {
  const escaped = value.replaceAll("&", "&amp;");
  return quote === "'" ? escaped.replaceAll("'", "&#39;") : escaped.replaceAll('"', "&quot;");
}

type SrcsetCandidate = { descriptor: string; url: string };

function parseSrcset(value: string): SrcsetCandidate[] {
  const candidates: SrcsetCandidate[] = [];
  let index = 0;
  while (index < value.length) {
    while (index < value.length && /[\s,]/.test(value[index] ?? "")) index += 1;
    if (index >= value.length) break;
    const urlStart = index;
    while (index < value.length && !/\s/.test(value[index] ?? "")) index += 1;
    let url = value.slice(urlStart, index);
    let trailingCommas = 0;
    while (url.endsWith(",")) {
      url = url.slice(0, -1);
      trailingCommas += 1;
    }
    if (url === "") continue;
    if (trailingCommas > 0) {
      candidates.push({ url, descriptor: "" });
      continue;
    }
    while (index < value.length && /\s/.test(value[index] ?? "")) index += 1;
    const descriptorStart = index;
    let parentheses = 0;
    while (index < value.length) {
      const character = value[index] ?? "";
      if (character === "(") parentheses += 1;
      if (character === ")") parentheses = Math.max(0, parentheses - 1);
      if (character === "," && parentheses === 0) break;
      index += 1;
    }
    const descriptor = value.slice(descriptorStart, index).trim();
    candidates.push({ url, descriptor });
    if (index < value.length && value[index] === ",") index += 1;
  }
  return candidates;
}

function rewriteSrcset(path: string, value: string, context: RewriteContext): string {
  return parseSrcset(value).map(({ url, descriptor }) => {
    const rewritten = inlineAssetReference(path, url, context);
    return `${rewritten}${descriptor === "" ? "" : ` ${descriptor}`}`;
  }).join(", ");
}

function importMapScript(context: RewriteContext): string {
  if (context.moduleSpecifiers.size === 0) return "";
  const imports = Object.fromEntries([...context.moduleSpecifiers].map(([specifier, path]) => {
    const cached = context.moduleUris.get(path);
    if (cached !== undefined) return [specifier, cached];
    const file = context.files.get(path);
    const body = context.moduleBodies.get(path);
    if (!file || body === undefined) return [specifier, specifier];
    const uri = dataUri(file, new TextEncoder().encode(body));
    context.moduleUris.set(path, uri);
    return [specifier, uri];
  }));
  return `<script type="importmap">${scriptJson({ imports })}</script>`;
}

function insertIntoHead(html: string, content: string): string {
  if (content === "") return html;
  const head = /<head(?:\s[^>]*)?>/i;
  return head.test(html) ? html.replace(head, (match) => `${match}${content}`) : `${content}${html}`;
}

function warnUnhandledReferences(path: string, html: string, context: RewriteContext): void {
  html.replace(/<([a-z][\w:-]*)\b([^>]*)>/gi, (_tag, rawName: string, attributes: string) => {
    const tag = rawName.toLowerCase();
    attributes.replace(/\b(href|src|poster|data|action)\s*=\s*(["'])([^"']+)\2/gi,
      (_attribute, rawName: string, _quote: string, rawReference: string) => {
        const name = rawName.toLowerCase();
        const reference = decodeAttribute(rawReference);
        const resolved = resolveReference(path, reference);
        if (resolved.kind === "external") return _attribute;
        if (resolved.kind === "escape") {
          warnOutside(context.warnings, reference);
          return _attribute;
        }
        if (tag === "a" && name === "href") {
          context.warnings.add(`webmcp-computer-preview: internal navigation unavailable: ${reference}`);
        } else if (context.budgetDroppedAssets.has(resolved.path)) {
          return _attribute;
        } else if (!context.files.has(resolved.path)) {
          warnMissing(context.warnings, reference);
        } else {
          context.warnings.add(`webmcp-computer-preview: unhandled local reference: ${tag} ${name}: ${reference}`);
        }
        return _attribute;
      });
    return _tag;
  });
}

function rewriteHtml(
  path: string,
  html: string,
  context: RewriteContext,
): string {
  let rewritten = html.replace(/<link\b([^>]*)>/gi, (original, attributes: string) => {
    const reference = attributeValue(attributes, "href");
    const rel = attributeValue(attributes, "rel")?.toLowerCase().split(/\s+/) ?? [];
    if (!reference || !rel.includes("stylesheet")) return original;
    const resolved = resolveReference(path, reference);
    if (resolved.kind === "external") return original;
    if (resolved.kind === "escape") {
      warnOutside(context.warnings, reference);
      return original;
    }
    const file = context.files.get(resolved.path);
    if (!file) {
      warnMissing(context.warnings, reference);
      return original;
    }
    context.includedCssImports.add(resolved.path);
    context.visitingCssImports.add(resolved.path);
    const css = rewriteCss(
      resolved.path,
      new TextDecoder().decode(file.body),
      context,
    ).replace(/<\/style/gi, "<\\/style");
    context.visitingCssImports.delete(resolved.path);
    const media = attributeValue(attributes, "media");
    return `<style data-webmcp-computer-inlined=""${media === undefined ? "" : ` media="${escapeAttribute(media)}"`}>${css}</style>`;
  });

  rewritten = rewritten.replace(
    /<script\b([^>]*)>([\s\S]*?)<\/script>/gi,
    (original, attributes: string, body: string) => {
      const reference = attributeValue(attributes, "src");
      const isModule = attributeValue(attributes, "type")?.toLowerCase() === "module";
      let code = body;
      let nextAttributes = attributes;
      if (reference !== undefined) {
        const resolved = resolveReference(path, reference);
        if (resolved.kind === "external") return original;
        if (resolved.kind === "escape") {
          warnOutside(context.warnings, reference);
          return original;
        }
        const file = context.files.get(resolved.path);
        if (!file) {
          warnMissing(context.warnings, reference);
          return original;
        }
        if (isModule) {
          code = `import ${JSON.stringify(registerModule(resolved.path, resolved.suffix, context))};`;
        } else {
          code = rewriteJavaScript(
            resolved.path,
            new TextDecoder().decode(file.body),
            context,
          );
        }
        nextAttributes = removeAttribute(attributes, "src");
        if (!isModule && /\bdefer\b/i.test(attributes)) {
          context.warnings.add(`webmcp-computer-preview: defer script delayed until DOMContentLoaded: ${reference}`);
          nextAttributes = nextAttributes.replace(/\s+defer\b/i, "");
          code = `document.readyState==="loading"?document.addEventListener("DOMContentLoaded",()=>{${code}\n},{once:true}):(()=>{${code}\n})();`;
        }
      } else {
        code = rewriteJavaScript(path, code, context);
      }
      return `<script${nextAttributes}>${code.replace(/<\/script/gi, "<\\/script")}</script>`;
    },
  );

  rewritten = rewritten.replace(
    /(<style(?:\s[^>]*)?>)([\s\S]*?)(<\/style>)/gi,
    (original, open: string, css: string, close: string) =>
      /\bdata-webmcp-computer-inlined\b/i.test(open)
        ? original
        : `${open}${rewriteCss(path, css, context)}${close}`,
  );

  rewritten = rewritten.replace(/<(?:img|source|video|audio|input)\b[^>]*>/gi, (tag) => {
    const withSources = tag.replace(
      /\b(src|poster)\s*=\s*(["'])([^"']+)\2/gi,
      (_attributeMatch, attribute: string, quote: string, reference: string) =>
        `${attribute}=${quote}${escapeAttribute(inlineAssetReference(path, decodeAttribute(reference), context), quote)}${quote}`,
    );
    return withSources.replace(
      /\bsrcset\s*=\s*(["'])([^"']+)\1/gi,
      (_attributeMatch, quote: string, value: string) =>
        `srcset=${quote}${escapeAttribute(rewriteSrcset(path, decodeAttribute(value), context), quote)}${quote}`,
    );
  });

  rewritten = rewritten.replace(/<link\b[^>]*>/gi, (tag) =>
    tag.replace(
      /\bhref\s*=\s*(["'])([^"']+)\1/i,
      (_attributeMatch, quote: string, reference: string) =>
        `href=${quote}${escapeAttribute(inlineAssetReference(path, decodeAttribute(reference), context), quote)}${quote}`,
    ),
  );

  rewritten = rewritten.replace(/<object\b[^>]*>/gi, (tag) =>
    tag.replace(
      /\bdata\s*=\s*(["'])([^"']+)\1/i,
      (_attributeMatch, quote: string, reference: string) =>
        `data=${quote}${escapeAttribute(inlineAssetReference(path, decodeAttribute(reference), context), quote)}${quote}`,
    ),
  );

  rewritten = rewritten.replace(/<form\b[^>]*>/gi, (tag) =>
    tag.replace(
      /\baction\s*=\s*(["'])([^"']+)\1/i,
      (_attributeMatch, quote: string, reference: string) =>
        `action=${quote}${escapeAttribute(inlineAssetReference(path, decodeAttribute(reference), context), quote)}${quote}`,
    ),
  );

  rewritten = rewritten.replace(
    /\bstyle\s*=\s*(["'])([^"']*)\1/gi,
    (_attributeMatch, quote: string, css: string) =>
      `style=${quote}${escapeAttribute(rewriteCss(path, decodeAttribute(css), context), quote)}${quote}`,
  );
  rewritten = insertIntoHead(rewritten, importMapScript(context));
  warnUnhandledReferences(path, rewritten, context);
  return rewritten;
}

export function buildSelfContainedDocument(
  files: readonly PreviewVirtualFile[],
  pid: number,
  token: string,
  entryPath = "index.html",
  options: { injectBridge?: boolean } = {},
): SelfContainedDocument {
  const byPath = new Map(files.map((file) => [file.path, file]));
  const entry = byPath.get(entryPath);
  if (!entry) throw new Error(`webmcp-computer: Preview could not create ${entryPath}`);
  const warnings = new Set<string>();
  const remainingAssetBytes = Math.max(
    0,
    MAX_PREVIEW_DOCUMENT_BYTES - entry.body.byteLength - PREVIEW_DOCUMENT_OVERHEAD_BYTES,
  );
  const context = createRewriteContext(byPath, warnings, remainingAssetBytes);
  const rewritten = rewriteHtml(
    entryPath,
    new TextDecoder().decode(entry.body),
    context,
  );
  const html = options.injectBridge === false
    ? rewritten
    : injectPreviewBridge(rewritten, pid, token, [...warnings]);
  return {
    html,
    warnings: [...warnings],
  };
}
