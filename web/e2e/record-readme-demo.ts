import { execFile } from "node:child_process";
import { rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { Page } from "puppeteer-core";
import {
  closeWebMCPComputerPage,
  executeWebMcpTool,
  openWebMCPComputerPage,
  startHarness,
  stopHarness,
  waitForFileSystemReady,
  waitForWebMcpTools,
  waitForWindow,
  type WebMCPComputerPage,
} from "./harness";

const here = dirname(fileURLToPath(import.meta.url));
const assetDirectory = resolve(here, "../../docs/assets/readme");
const videoPath = resolve(assetDirectory, "webmcp-computer-demo.mp4") as `${string}.mp4`;
const sourceVideoPath = resolve(assetDirectory, "webmcp-computer-demo-source.webm") as `${string}.webm`;
const heroPath = resolve(assetDirectory, "hero.png") as `${string}.png`;
const runFile = promisify(execFile);

const pause = (milliseconds: number) => new Promise((resolvePause) => {
  setTimeout(resolvePause, milliseconds);
});

type AppOpenResult = {
  pid: number;
};

type TerminalResult = {
  exit_code: number;
  stderr: string;
  stdout: string;
};

const pizzaDemo = String.raw`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Slice/01</title>
  <style>
    * { box-sizing: border-box; }
    :root { color-scheme: light; font-family: Inter, ui-sans-serif, system-ui, sans-serif; }
    body { margin: 0; min-height: 100vh; color: #24180f; background: #f7ead8; }
    header { display: flex; align-items: center; justify-content: space-between; padding: 20px 24px 14px; }
    .brand { font-size: 28px; font-weight: 900; letter-spacing: -0.06em; }
    .brand span { color: #e65332; }
    .live { padding: 7px 10px; border: 1px solid #d9bea0; border-radius: 99px; font: 700 9px/1 ui-monospace, monospace; letter-spacing: .14em; text-transform: uppercase; background: #fff8ee; }
    .live::before { content: ""; display: inline-block; width: 6px; height: 6px; margin-right: 6px; border-radius: 50%; background: #28a66a; box-shadow: 0 0 0 4px #dff4e8; }
    main { display: grid; grid-template-columns: minmax(0, 1fr) 245px; gap: 16px; padding: 0 24px 22px; }
    .eyebrow { margin: 8px 0 7px; color: #9b593b; font: 800 9px/1 ui-monospace, monospace; letter-spacing: .16em; text-transform: uppercase; }
    h1 { max-width: 560px; margin: 0 0 18px; font-size: clamp(31px, 4vw, 52px); line-height: .95; letter-spacing: -.055em; }
    .menu { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 10px; }
    .card { min-height: 200px; padding: 14px; border: 1px solid #dec5a8; border-radius: 16px; background: rgba(255,255,255,.58); box-shadow: 0 12px 30px rgba(102,55,26,.08); }
    .pizza { width: 58px; height: 58px; margin-bottom: 18px; border-radius: 50%; background-color: #f5c768; box-shadow: inset 0 0 0 5px #ffe5a3, 0 5px 12px rgba(102,55,26,.12); }
    .pizza--margherita { background-image: radial-gradient(circle at 31% 35%, #e65332 0 5px, transparent 6px), radial-gradient(circle at 67% 62%, #e65332 0 5px, transparent 6px), radial-gradient(circle at 64% 25%, #4c9b62 0 3px, transparent 4px); }
    .pizza--pepperoni { background-image: radial-gradient(circle at 30% 31%, #bd3e2d 0 6px, transparent 7px), radial-gradient(circle at 68% 37%, #bd3e2d 0 6px, transparent 7px), radial-gradient(circle at 48% 70%, #bd3e2d 0 6px, transparent 7px); }
    .pizza--mushroom { background-image: radial-gradient(ellipse at 31% 38%, #725447 0 5px, transparent 6px), radial-gradient(ellipse at 67% 65%, #725447 0 5px, transparent 6px), radial-gradient(ellipse at 70% 25%, #725447 0 5px, transparent 6px); }
    .card h2 { margin: 0 0 5px; font-size: 16px; }
    .card p { min-height: 34px; margin: 0 0 12px; color: #775d4c; font-size: 11px; line-height: 1.45; }
    .price { font: 800 11px/1 ui-monospace, monospace; }
    .cart { display: flex; min-height: 390px; flex-direction: column; padding: 17px; border-radius: 18px; color: #fffaf4; background: #281c18; box-shadow: 0 16px 40px rgba(53,30,20,.22); }
    .cart h2 { display: flex; justify-content: space-between; margin: 0; font-size: 18px; }
    .count { display: grid; width: 23px; height: 23px; place-items: center; border-radius: 50%; color: #281c18; background: #f4c55e; font: 800 10px/1 ui-monospace, monospace; }
    #cart-lines { flex: 1; margin-top: 20px; }
    .empty { color: #baa99f; font-size: 12px; line-height: 1.5; }
    .line { display: flex; justify-content: space-between; gap: 10px; padding: 10px 0; border-bottom: 1px solid rgba(255,255,255,.12); font-size: 11px; }
    .line small { display: block; margin-top: 3px; color: #baa99f; }
    .total { display: flex; justify-content: space-between; padding-top: 14px; font: 800 14px/1 ui-monospace, monospace; }
    #receipt { margin-top: 14px; padding: 12px; border-radius: 11px; color: #281c18; background: #a8efc5; font-size: 11px; line-height: 1.45; }
    #receipt strong { display: block; font: 900 12px/1.3 ui-monospace, monospace; }
    footer { position: fixed; right: 270px; bottom: 12px; left: 24px; display: flex; align-items: center; gap: 8px; color: #775d4c; font: 700 9px/1 ui-monospace, monospace; letter-spacing: .08em; text-transform: uppercase; }
    footer::before { content: ""; width: 7px; height: 7px; border-radius: 50%; background: #2e9ff3; box-shadow: 0 0 0 4px rgba(46,159,243,.13); }
    .pulse { animation: pulse .55s ease; }
    @keyframes pulse { 50% { transform: translateY(-3px); box-shadow: 0 20px 48px rgba(230,83,50,.24); } }
    @media (max-width: 620px) {
      main { grid-template-columns: 1fr; }
      .menu { grid-template-columns: 1fr; }
      .cart { min-height: 260px; }
      footer { display: none; }
    }
  </style>
</head>
<body>
  <header>
    <div class="brand">SLICE<span>/01</span></div>
    <div class="live">4 WebMCP tools live</div>
  </header>
  <main>
    <section>
      <p class="eyebrow">Wood-fired / made for two kinds of user</p>
      <h1>Good pizza.<br>Zero coordinate guessing.</h1>
      <div class="menu">
        <article class="card"><div class="pizza pizza--margherita"></div><h2>Margherita</h2><p>Tomato, fior di latte, basil.</p><span class="price">$14 / $19</span></article>
        <article class="card"><div class="pizza pizza--pepperoni"></div><h2>Pepperoni</h2><p>Cup-and-char pepperoni, hot honey.</p><span class="price">$17 / $23</span></article>
        <article class="card"><div class="pizza pizza--mushroom"></div><h2>Night Mushroom</h2><p>Roasted mushroom, thyme, pecorino.</p><span class="price">$18 / $24</span></article>
      </div>
    </section>
    <aside class="cart" id="cart">
      <h2>Your order <span class="count" id="count">0</span></h2>
      <div id="cart-lines"><p class="empty">Waiting for a human or an agent to add something delicious.</p></div>
      <div class="total"><span>TOTAL</span><span id="total">$0</span></div>
      <div id="receipt" hidden></div>
    </aside>
  </main>
  <footer id="activity">Agent-ready / shared cart online</footer>
  <script>
    const menu = [
      { id: "margherita", name: "Margherita", description: "Tomato, fior di latte, basil", prices: { small: 14, large: 19 } },
      { id: "pepperoni", name: "Pepperoni", description: "Cup-and-char pepperoni, hot honey", prices: { small: 17, large: 23 } },
      { id: "night_mushroom", name: "Night Mushroom", description: "Roasted mushroom, thyme, pecorino", prices: { small: 18, large: 24 } },
    ];
    const cart = [];
    const money = (value) => "$" + value;
    const total = () => cart.reduce((sum, item) => sum + item.price * item.quantity, 0);
    function render(message) {
      const lines = document.getElementById("cart-lines");
      const count = cart.reduce((sum, item) => sum + item.quantity, 0);
      document.getElementById("count").textContent = String(count);
      document.getElementById("total").textContent = money(total());
      lines.innerHTML = cart.length === 0
        ? '<p class="empty">Waiting for a human or an agent to add something delicious.</p>'
        : cart.map((item) => '<div class="line"><span>' + item.quantity + '× ' + item.name + '<small>' + item.size + '</small></span><b>' + money(item.price * item.quantity) + '</b></div>').join("");
      document.getElementById("activity").textContent = message;
      const surface = document.getElementById("cart");
      surface.classList.remove("pulse");
      requestAnimationFrame(() => surface.classList.add("pulse"));
    }
    const tools = [
      {
        name: "site_menu_get",
        description: "Read the stable Slice/01 menu IDs, descriptions, sizes, and USD prices.",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
        execute: () => ({ items: menu, currency: "USD" }),
      },
      {
        name: "site_pizza_add",
        description: "Add 1-8 pizzas to the visible shared cart using a stable pizza ID and size.",
        inputSchema: {
          type: "object",
          properties: {
            pizza_id: { type: "string", enum: ["margherita", "pepperoni", "night_mushroom"] },
            size: { type: "string", enum: ["small", "large"] },
            quantity: { type: "integer", minimum: 1, maximum: 8 },
          },
          required: ["pizza_id", "size", "quantity"],
          additionalProperties: false,
        },
        execute: ({ pizza_id, size, quantity }) => {
          const pizza = menu.find((item) => item.id === pizza_id);
          const item = { pizza_id, name: pizza.name, size, quantity, price: pizza.prices[size] };
          cart.push(item);
          render("Agent · added " + quantity + " large pepperoni");
          return { added: item, item_count: quantity, total_usd: total() };
        },
      },
      {
        name: "site_cart_get",
        description: "Read the visible shared cart, item count, currency, and USD total.",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
        execute: () => ({ items: cart, item_count: cart.reduce((sum, item) => sum + item.quantity, 0), total_usd: total(), currency: "USD" }),
      },
      {
        name: "site_order_place",
        description: "Create a local demo order and visibly show its receipt. This sends nothing externally.",
        inputSchema: { type: "object", properties: { label: { type: "string" } }, additionalProperties: false },
        execute: ({ label } = {}) => {
          const receipt = document.getElementById("receipt");
          receipt.hidden = false;
          receipt.innerHTML = '<strong>ORDER SL-1042 · CONFIRMED</strong>' + (label || "WebMCP pickup") + '<br>Ready in 18 minutes';
          render("Agent · placed demo order SL-1042");
          return { order_id: "SL-1042", status: "confirmed", eta_minutes: 18, total_usd: total() };
        },
      },
    ];
    Promise.all(tools.map((tool) => document.modelContext.registerTool(tool)))
      .then(() => { document.getElementById("activity").textContent = "4 WebMCP tools registered / waiting for a call"; });
  </script>
</body>
</html>`;

async function selectToolMonitor(page: Page): Promise<void> {
  await page.evaluate(() => {
    const button = [...document.querySelectorAll<HTMLButtonElement>("button")]
      .find((candidate) => candidate.textContent?.trim() === "Tool Monitor");
    if (!button) throw new Error("WebMCP Computer demo could not find Tool Monitor tab");
    button.click();
  });
  await page.waitForSelector(".tool-monitor", { visible: true });
}

async function showNewestTools(page: Page): Promise<void> {
  await page.evaluate(() => {
    const monitor = document.querySelector<HTMLElement>(".tool-monitor");
    if (monitor) monitor.scrollTop = monitor.scrollHeight;
  });
}

async function runDemo(computer: WebMCPComputerPage): Promise<void> {
  const { page } = computer;
  await page.setViewport({ width: 1280, height: 720, deviceScaleFactor: 1 });
  await waitForFileSystemReady(page);
  await pause(1_400);

  const recorder = await page.screencast({
    path: sourceVideoPath,
    format: "webm",
    fps: 30,
    quality: 18,
    ffmpegPath: "/opt/homebrew/bin/ffmpeg",
  });

  try {
    await pause(1_600);
    await executeWebMcpTool(page, "screensaver_wake");
    await pause(1_100);

    const files = await executeWebMcpTool<AppOpenResult>(page, "app_open", {
      appId: "files", x: 28, y: 42, width: 355, height: 255, focus: false,
    });
    await pause(850);
    const editor = await executeWebMcpTool<AppOpenResult>(page, "app_open", {
      appId: "editor", path: "~/desktop/pizza-demo.md", x: 405, y: 42,
      width: 835, height: 525, focus: true,
    });
    await pause(2_400);

    const terminal = await executeWebMcpTool<AppOpenResult>(page, "app_open", {
      appId: "terminal", x: 56, y: 335, width: 610, height: 305, focus: true,
    });
    await executeWebMcpTool<TerminalResult>(page, "term_exec", {
      command: 'mkdir -p pizza-demo && echo "scaffolding Slice/01..."',
      term_pid: terminal.pid,
    });
    await pause(900);
    await executeWebMcpTool(page, "fs_write", {
      path: "~/pizza-demo/index.html",
      content: pizzaDemo,
    });
    await pause(900);
    await executeWebMcpTool(page, "editor_open_file", {
      path: "~/pizza-demo/index.html",
      pid: editor.pid,
    });
    await pause(1_900);

    const served = await executeWebMcpTool<TerminalResult>(page, "term_exec", {
      command: "serve pizza-demo/",
      term_pid: terminal.pid,
    });
    if (served.exit_code !== 0 || served.stderr !== "") {
      throw new Error(`WebMCP Computer demo serve failed: ${served.stderr || served.stdout}`);
    }
    const previewPid = Number(served.stdout.match(/preview \(pid (\d+)\)/)?.[1]);
    if (!Number.isInteger(previewPid)) throw new Error("WebMCP Computer demo did not return a Preview PID");
    await waitForWindow(page, "Preview", previewPid);
    await waitForWebMcpTools(page, [
      "preview_get_url",
      "site_menu_get",
      "site_pizza_add",
      "site_cart_get",
      "site_order_place",
    ]);
    await pause(1_200);

    await executeWebMcpTool(page, "app_close", { pid: files.pid });
    await executeWebMcpTool(page, "app_close", { pid: editor.pid });
    await executeWebMcpTool(page, "window_move", { pid: previewPid, x: 18, y: 34 });
    await executeWebMcpTool(page, "window_resize", { pid: previewPid, width: 782, height: 602 });
    await executeWebMcpTool(page, "window_move", { pid: terminal.pid, x: 818, y: 415 });
    await executeWebMcpTool(page, "window_resize", { pid: terminal.pid, width: 442, height: 225 });

    const settings = await executeWebMcpTool<AppOpenResult>(page, "app_open", {
      appId: "settings", x: 818, y: 34, width: 442, height: 362, focus: true,
    });
    await waitForWindow(page, "Settings", settings.pid);
    await selectToolMonitor(page);
    await showNewestTools(page);
    await pause(2_200);

    await executeWebMcpTool(page, "site_menu_get");
    await pause(850);
    await executeWebMcpTool(page, "site_pizza_add", {
      pizza_id: "pepperoni",
      size: "large",
      quantity: 1,
    });
    await showNewestTools(page);
    await pause(1_500);
    await executeWebMcpTool(page, "site_cart_get");
    await pause(750);
    await executeWebMcpTool(page, "site_order_place", { label: "WebMCP pickup" });
    await showNewestTools(page);

    const previewFrame = page.frames().find((frame) =>
      frame.parentFrame() === page.mainFrame() && frame.url() === "about:srcdoc"
    );
    if (!previewFrame) throw new Error("WebMCP Computer demo Preview frame missing");
    await previewFrame.waitForSelector("#receipt:not([hidden])", { visible: true });
    await pause(450);
    await page.screenshot({ path: heroPath, type: "png" });
    await pause(3_800);

    await executeWebMcpTool(page, "window_focus", { pid: settings.pid });
    await showNewestTools(page);
    await pause(1_200);
  } finally {
    await recorder.stop();
  }

  await runFile("/opt/homebrew/bin/ffmpeg", [
    "-y",
    "-i", sourceVideoPath,
    "-an",
    "-c:v", "libx264",
    "-preset", "slow",
    "-crf", "22",
    "-pix_fmt", "yuv420p",
    "-movflags", "+faststart",
    videoPath,
  ]);
  await rm(sourceVideoPath, { force: true });
}

let computer: WebMCPComputerPage | undefined;
try {
  await startHarness();
  computer = await openWebMCPComputerPage();
  await runDemo(computer);
} finally {
  if (computer) await closeWebMCPComputerPage(computer).catch(() => undefined);
  await stopHarness();
}

console.log(`Recorded ${videoPath}`);
console.log(`Captured ${heroPath}`);
