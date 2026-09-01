import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { PUBLISHED_SITE_RETENTION_DAYS } from "../../../workers/computer/src/protocol";
import { PublishToast } from "./AgentPresence";

test("renders published URL, QR, and returned retention window", () => {
  const url = "https://computer.test/s/aaaaaaaa/";
  const html = renderToStaticMarkup(createElement(PublishToast, {
    url,
    expiresInDays: PUBLISHED_SITE_RETENTION_DAYS,
  }));

  expect(html).toContain("SITE PUBLISHED");
  expect(html).toContain(url);
  expect(html).toContain(
    `PUBLIC · EXPIRES IN ${PUBLISHED_SITE_RETENTION_DAYS} DAYS`,
  );
  expect(html).toContain(`aria-label="QR code for ${url}"`);
});
