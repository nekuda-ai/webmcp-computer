import type { ReactNode } from "react";

type MarkdownPreviewProps = {
  content: string;
};

export function MarkdownPreview({ content }: MarkdownPreviewProps) {
  const lines = content.split("\n");
  const blocks: ReactNode[] = [];

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const key = `${index}:${line}`;
    if (line.startsWith("- ")) {
      const items: ReactNode[] = [];
      while (index < lines.length && lines[index]?.startsWith("- ")) {
        const item = lines[index] ?? "";
        items.push(<li key={`${index}:${item}`}>{item.slice(2)}</li>);
        index += 1;
      }
      index -= 1;
      blocks.push(<ul key={key}>{items}</ul>);
    } else if (line.startsWith("### ")) {
      blocks.push(<h3 key={key}>{line.slice(4)}</h3>);
    } else if (line.startsWith("## ")) {
      blocks.push(<h2 key={key}>{line.slice(3)}</h2>);
    } else if (line.startsWith("# ")) {
      blocks.push(<h1 key={key}>{line.slice(2)}</h1>);
    } else if (line.trim() === "") {
      blocks.push(<br key={key} />);
    } else {
      blocks.push(<p key={key}>{line}</p>);
    }
  }

  return (
    <article className="markdown-preview">{blocks}</article>
  );
}
