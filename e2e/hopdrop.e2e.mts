// End-to-end tests: real Chromium pages, a real production build of this
// client, and real hopdrop-signaling servers. Covers what node:test unit
// tests can't reach - DOM wiring, Bootstrap modals, URL handling on load,
// and WebRTC connections actually opening.
//
// Run with `npm run test:e2e`. Needs:
//   - hopdrop-signaling checked out next to this repo (or its path in
//     HOPDROP_SIGNALING_DIR), with `npm install` done there.
//   - Playwright's Chromium: `npx playwright install chromium` (once).
// Starts two signaling servers (the second plays a third-party server) and
// a preview server on ports that don't clash with `npm run dev`. TURN is
// never actually used, so the Metered settings are dummies.
//
// hopdrop-signaling rate-limits per IP: at most 5 open connections and 20
// connection attempts a minute - and every page here connects from the
// same IP. Pages are closed after each test to stay under the first; the
// whole suite makes about 18 connections to the default server, so a new
// test that connects there may need to use the third-party server, or the
// suite split, to stay under the second.
//
// HOPDROP_E2E_OFFLINE=1 serves Bootstrap's JS from node_modules and blanks
// the other CDN/font/site stylesheets, for machines without internet.

import { after, afterEach, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build, preview, type PreviewServer } from "vite";
import {
  chromium,
  type Browser,
  type BrowserContext,
  type Page,
} from "playwright";

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const SIGNALING_DIR =
  process.env.HOPDROP_SIGNALING_DIR ??
  path.resolve(REPO_ROOT, "../hopdrop-signaling");
const CLIENT_PORT = 4310;
const SIGNALING_PORT = 4320;
const THIRD_PARTY_PORT = 4321;
const BASE = `http://localhost:${CLIENT_PORT}/`;
const DEFAULT_SIGNALING = `ws://localhost:${SIGNALING_PORT}`;
const THIRD_PARTY_SIGNALING = `ws://localhost:${THIRD_PARTY_PORT}`;
const OFFLINE = process.env.HOPDROP_E2E_OFFLINE === "1";
const DEVICE_NAME_STORAGE_KEY = "hopdrop_device_name";
const TIMEOUT = 20_000;

let work_dir = "";
let browser: Browser;
let preview_server: PreviewServer;
const servers: ChildProcess[] = [];
const contexts: BrowserContext[] = [];

function start_signaling(port: number, secret_file: string): Promise<void> {
  const child = spawn(process.execPath, ["--import", "tsx", "src/index.mts"], {
    cwd: SIGNALING_DIR,
    env: {
      ...process.env,
      PORT: String(port),
      METERED_API_KEY_FILE: secret_file,
      METERED_CREDENTIALS_URL: "https://e2e.invalid",
      ALLOWED_ORIGINS: `http://localhost:${CLIENT_PORT}`,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  servers.push(child);
  return new Promise((resolve, reject) => {
    let output = "";
    const on_data = (chunk: Buffer): void => {
      output += chunk.toString();
      if (output.includes("listening")) {
        resolve();
      }
    };
    child.stdout?.on("data", on_data);
    child.stderr?.on("data", on_data);
    child.on("exit", (code) =>
      reject(
        new Error(
          `hopdrop-signaling (port ${port}) exited with ${code}. Is it checked out at ${SIGNALING_DIR} with npm install done?\n${output}`,
        ),
      ),
    );
  });
}

async function new_page(device_name?: string): Promise<Page> {
  const context = await browser.newContext();
  contexts.push(context);
  if (device_name !== undefined) {
    await context.addInitScript(
      ([key, name]) => window.localStorage.setItem(key, name),
      [DEVICE_NAME_STORAGE_KEY, device_name] as const,
    );
  }
  if (OFFLINE) {
    const bootstrap_js = await readFile(
      path.join(
        REPO_ROOT,
        "node_modules/bootstrap/dist/js/bootstrap.bundle.min.js",
      ),
      "utf8",
    );
    const bootstrap_css = await readFile(
      path.join(REPO_ROOT, "node_modules/bootstrap/dist/css/bootstrap.min.css"),
      "utf8",
    );
    await context.route(
      "https://cdn.jsdelivr.net/**/bootstrap.bundle.min.js",
      (route) =>
        route.fulfill({ body: bootstrap_js, contentType: "text/javascript" }),
    );
    await context.route(
      "https://cdn.jsdelivr.net/**/bootstrap.min.css",
      (route) =>
        route.fulfill({ body: bootstrap_css, contentType: "text/css" }),
    );
    await context.route(/stampatron\.com|googleapis|bootstrap-icons/, (route) =>
      route.fulfill({ body: "", contentType: "text/css" }),
    );
    // Local copies don't match the CDN versions' integrity hashes.
    await context.route(`${BASE}**`, async (route) => {
      if (route.request().resourceType() !== "document") {
        return route.continue();
      }
      const response = await route.fetch();
      const body = (await response.text()).replace(/integrity="[^"]*"/g, "");
      return route.fulfill({ response, body });
    });
  }
  return context.newPage();
}

async function connect(page: Page, signaling_url?: string): Promise<void> {
  if (signaling_url !== undefined) {
    await page.fill("#ws-url", signaling_url);
  }
  await page.click("#connect");
  await page.waitForFunction(
    () =>
      document.querySelector("#status")?.textContent ===
      "Connected to signaling",
    null,
    { timeout: TIMEOUT },
  );
}

// Creates a room and returns its join link.
async function create_room(
  page: Page,
  name: string,
  signaling_url?: string,
): Promise<string> {
  await page.goto(BASE);
  await page.fill("#device-name", name);
  await connect(page, signaling_url);
  await page.click("#join");
  await page.waitForFunction(
    () => (document.querySelector("#join-link")?.textContent ?? "").length > 0,
    null,
    { timeout: TIMEOUT },
  );
  return (await page.textContent("#join-link")) ?? "";
}

async function peer_labels(page: Page): Promise<string[]> {
  return page.$$eval("#peer-select option", (options) =>
    options
      .filter((option) => (option as HTMLOptionElement).value !== "")
      .map((option) => option.textContent ?? ""),
  );
}

async function wait_for_peers(page: Page, count: number): Promise<string[]> {
  await page.waitForFunction(
    (n) =>
      [
        ...document.querySelectorAll<HTMLOptionElement>("#peer-select option"),
      ].filter((option) => option.value !== "").length >= n,
    count,
    { timeout: TIMEOUT },
  );
  return peer_labels(page);
}

function room_code_of(link: string): string {
  return new URL(link).hash.slice(1).split(/[.@]/)[0] ?? "";
}

async function is_visible(page: Page, selector: string): Promise<boolean> {
  return page.$eval(selector, (el) => !el.classList.contains("d-none"));
}

before(async () => {
  work_dir = await mkdtemp(path.join(tmpdir(), "hopdrop-e2e-"));
  const secret_file = path.join(work_dir, "metered-key");
  await writeFile(secret_file, "e2e-dummy");
  await Promise.all([
    start_signaling(SIGNALING_PORT, secret_file),
    start_signaling(THIRD_PARTY_PORT, secret_file),
  ]);

  const config_file = path.join(REPO_ROOT, "config/vite.config.ts");
  const out_dir = path.join(work_dir, "dist");
  process.env.VITE_SIGNALING_URL = DEFAULT_SIGNALING;
  await build({
    configFile: config_file,
    logLevel: "warn",
    build: { outDir: out_dir, emptyOutDir: true },
  });
  preview_server = await preview({
    configFile: config_file,
    logLevel: "warn",
    build: { outDir: out_dir },
    preview: { port: CLIENT_PORT, strictPort: true },
  });

  // Newer Chromium blocks pages from reaching other local ports without a
  // permission prompt; the servers here are all deliberately local.
  browser = await chromium.launch({
    args: ["--disable-features=LocalNetworkAccessChecks"],
  });
});

// Closing a test's pages closes their signaling connections, freeing
// slots under the server's per-IP connection cap for the next test.
afterEach(async () => {
  await Promise.all(contexts.splice(0).map((context) => context.close()));
});

after(async () => {
  await browser?.close();
  await preview_server?.close();
  for (const child of servers) {
    child.kill();
  }
  if (work_dir !== "") {
    await rm(work_dir, { recursive: true, force: true });
  }
});

describe("joining by link", () => {
  test("with a remembered name, a link joins automatically and is verified", async () => {
    const creator = await new_page();
    const link = await create_room(creator, "Alpha");
    assert.match(
      link,
      /^http:\/\/localhost:4310\/#[2-9A-HJKMNP-Z]{6}\.[A-Za-z0-9_-]{22}$/,
    );
    assert.equal(await is_visible(creator, "#signaling-notice"), false);

    const joiner = await new_page("Bravo");
    await joiner.goto(link);
    assert.deepEqual(await wait_for_peers(joiner, 1), ["Alpha"]);
    assert.deepEqual(await wait_for_peers(creator, 1), ["Bravo"]);

    assert.equal(
      joiner.url(),
      BASE,
      "join fragment is cleared from the address bar",
    );
    assert.equal(
      await joiner.$eval("#send-tab", (el) => el.classList.contains("active")),
      true,
      "link joiner is moved to the Send tab",
    );
    assert.equal(
      await creator.$eval("#connect-tab", (el) =>
        el.classList.contains("active"),
      ),
      true,
      "creator stays on Connect",
    );
  });

  test("without a remembered name, the join dialog asks for one and shows server errors", async () => {
    const creator = await new_page();
    const link = await create_room(creator, "Alpha");

    const joiner = await new_page();
    await joiner.goto(link);
    await joiner.waitForSelector("#join-guide-modal.show", {
      timeout: TIMEOUT,
    });
    assert.equal(
      await joiner.textContent("#join-guide-room"),
      room_code_of(link),
    );
    await joiner.waitForFunction(
      () => document.activeElement?.id === "join-guide-name",
    );
    assert.equal(
      await joiner.$eval("#join-guide-submit", (el) =>
        el.classList.contains("join-guide-pulse"),
      ),
      false,
      "no pulse before a name is typed",
    );

    // Submitted with Enter, as on a phone keyboard.
    await joiner.keyboard.type("Alpha");
    assert.equal(
      await joiner.$eval("#join-guide-submit", (el) =>
        el.classList.contains("join-guide-pulse"),
      ),
      true,
    );
    await joiner.keyboard.press("Enter");
    await joiner.waitForFunction(
      () =>
        (
          document.querySelector("#join-guide-error")?.textContent ?? ""
        ).includes("already taken"),
      null,
      { timeout: TIMEOUT },
    );
    await joiner.waitForSelector("#join-guide-modal.show");

    await joiner.fill("#join-guide-name", "Bravo");
    await joiner.click("#join-guide-submit");
    assert.deepEqual(await wait_for_peers(joiner, 1), ["Alpha"]);
    await joiner.waitForSelector("#join-guide-modal", { state: "hidden" });
    assert.equal(
      await joiner.evaluate(() =>
        window.localStorage.getItem("hopdrop_device_name"),
      ),
      "Bravo",
    );
  });

  test("an empty name is caught in the dialog without contacting the server", async () => {
    const creator = await new_page();
    const link = await create_room(creator, "Alpha");
    const joiner = await new_page();
    await joiner.goto(link);
    await joiner.waitForSelector("#join-guide-modal.show", {
      timeout: TIMEOUT,
    });
    await joiner.click("#join-guide-submit");
    assert.match(
      (await joiner.textContent("#join-guide-error")) ?? "",
      /enter a device name/,
    );
    assert.equal(
      await joiner.$eval("#join-guide-name", (el) =>
        el.classList.contains("is-invalid"),
      ),
      true,
    );
  });

  test("a TURN link closes the join dialog before the TURN consent opens", async () => {
    const joiner = await new_page();
    // A room that doesn't exist is fine - the consent comes before the join.
    await joiner.goto(`${BASE}#ABC234.t.Xq3vN8kLp2RmT7wYc9ZbFg`);
    await joiner.waitForSelector("#join-guide-modal.show", {
      timeout: TIMEOUT,
    });
    assert.equal(await joiner.isChecked("#use-turn"), true);
    await joiner.fill("#join-guide-name", "Charlie");
    await joiner.press("#join-guide-name", "Enter");
    await joiner.waitForSelector("#turn-warning-modal.show", {
      timeout: TIMEOUT,
    });
    assert.equal(await joiner.$("#join-guide-modal.show"), null);
    assert.equal(await is_visible(joiner, "#turn-warning-third-party"), false);
  });

  test("refreshing after a link join doesn't try to rejoin", async () => {
    const creator = await new_page();
    const link = await create_room(creator, "Alpha");
    const joiner = await new_page("Bravo");
    await joiner.goto(link);
    await wait_for_peers(joiner, 1);
    await joiner.reload();
    await joiner.waitForTimeout(500);
    assert.equal(await joiner.textContent("#status"), "Not connected");
    assert.equal(await joiner.$("#join-guide-modal.show"), null);
  });

  test("an in-page anchor isn't mistaken for a join link", async () => {
    const page = await new_page("Fox");
    await page.goto(`${BASE}#app`);
    await page.waitForTimeout(500);
    assert.equal(page.url(), `${BASE}#app`);
    assert.equal(await page.textContent("#status"), "Not connected");
  });

  test("opening a new link while connected asks before reloading", async () => {
    const creator = await new_page();
    const link = await create_room(creator, "Alpha");
    const joiner = await new_page("Bravo");
    await joiner.goto(link);
    await wait_for_peers(joiner, 1);

    let dialog_message = "";
    joiner.once("dialog", (dialog) => {
      dialog_message = dialog.message();
      void dialog.dismiss();
    });
    await joiner.evaluate(() => {
      window.location.hash = "ZZZ234.Xq3vN8kLp2RmT7wYc9ZbFg";
    });
    await joiner.waitForTimeout(500);
    assert.match(dialog_message, /current connections will be closed/);
    assert.equal(
      joiner.url(),
      BASE,
      "declined link is cleared, page not reloaded",
    );
    assert.deepEqual(await peer_labels(joiner), ["Alpha"]);
  });
});

describe("joining by typed code", () => {
  test("connects to link holders, but every connection is unverified", async () => {
    const creator = await new_page();
    const link = await create_room(creator, "Alpha");
    const scanner = await new_page("Bravo");
    await scanner.goto(link);
    await wait_for_peers(scanner, 1);

    const typed = await new_page();
    await typed.goto(BASE);
    await typed.fill("#device-name", "Charlie");
    await connect(typed);
    await typed.fill("#room-code", room_code_of(link));
    await typed.click("#join");

    assert.deepEqual((await wait_for_peers(typed, 2)).sort(), [
      "Alpha (unverified)",
      "Bravo (unverified)",
    ]);
    assert.deepEqual((await wait_for_peers(creator, 2)).sort(), [
      "Bravo",
      "Charlie (unverified)",
    ]);
    assert.deepEqual((await wait_for_peers(scanner, 2)).sort(), [
      "Alpha",
      "Charlie (unverified)",
    ]);

    // A device without the key can't hand one on: its link carries none.
    const typed_link = (await typed.textContent("#join-link")) ?? "";
    assert.equal(new URL(typed_link).hash, `#${room_code_of(link)}`);
    assert.equal(
      await typed.$eval("#connect-tab", (el) =>
        el.classList.contains("active"),
      ),
      true,
      "typed-code joiner stays on Connect",
    );
  });
});

describe("file transfer", () => {
  test("a file sent over a verified connection arrives with its hash verified", async () => {
    const creator = await new_page();
    const link = await create_room(creator, "Alpha");
    const joiner = await new_page("Bravo");
    await joiner.goto(link);
    await wait_for_peers(creator, 1);

    const content = Buffer.from("hopdrop e2e ".repeat(50_000));
    await creator.click("#send-tab");
    await creator.selectOption("#peer-select", { label: "Bravo" });
    await creator.setInputFiles("#file-input", {
      name: "e2e.txt",
      mimeType: "text/plain",
      buffer: content,
    });
    await creator.click("#send-file");
    await joiner.waitForFunction(
      () =>
        (document.querySelector("#downloads")?.textContent ?? "").includes(
          "e2e.txt",
        ),
      null,
      { timeout: TIMEOUT },
    );
    assert.match(
      (await joiner.textContent("#downloads")) ?? "",
      /e2e\.txt \(hash verified\)/,
    );
  });
});

describe("third-party signaling server", () => {
  test("is flagged on both devices and carried in the join link", async () => {
    const creator = await new_page();
    const link = await create_room(creator, "Delta", THIRD_PARTY_SIGNALING);
    assert.equal(await is_visible(creator, "#signaling-notice"), true);
    assert.equal(
      await creator.textContent("#signaling-notice-host"),
      `localhost:${THIRD_PARTY_PORT}`,
    );
    assert.match(link, new RegExp(`@ws://localhost:${THIRD_PARTY_PORT}$`));

    const joiner = await new_page();
    await joiner.goto(link);
    await joiner.waitForSelector("#join-guide-modal.show", {
      timeout: TIMEOUT,
    });
    assert.equal(await is_visible(joiner, "#join-guide-third-party"), true);
    assert.equal(await is_visible(joiner, "#signaling-notice"), true);
    await joiner.fill("#join-guide-name", "Echo");
    await joiner.press("#join-guide-name", "Enter");
    assert.deepEqual(await wait_for_peers(joiner, 1), ["Delta"]);
    assert.equal(
      await joiner.inputValue("#ws-url"),
      `${THIRD_PARTY_SIGNALING}/`,
    );
  });

  test("its TURN consent is separate from the default server's", async () => {
    const page = await new_page();
    await page.goto(BASE);
    await page.evaluate(() =>
      window.localStorage.setItem("hopdrop_turn_warning_acknowledged", "1"),
    );
    await page.fill("#device-name", "Golf");
    await connect(page, THIRD_PARTY_SIGNALING);
    await page.check("#use-turn");
    await page.click("#join");
    await page.waitForSelector("#turn-warning-modal.show", {
      timeout: TIMEOUT,
    });
    assert.equal(await is_visible(page, "#turn-warning-third-party"), true);
  });
});

describe("tampering signaling server", () => {
  test("a corrupted offer is blocked and flagged", async () => {
    const creator = await new_page();
    // Sits between the creator's page and the real server, corrupting the
    // ciphertext of every offer relayed to it.
    await creator.routeWebSocket(new RegExp(`:${SIGNALING_PORT}/?$`), (ws) => {
      const server = ws.connectToServer();
      server.onMessage((raw) => {
        const message = JSON.parse(String(raw)) as {
          type: string;
          payload?: { ct?: string };
        };
        const ct = message.payload?.ct;
        if (
          message.type === "offer" &&
          ct !== undefined &&
          message.payload !== undefined
        ) {
          message.payload.ct = (ct.startsWith("A") ? "B" : "A") + ct.slice(1);
        }
        ws.send(JSON.stringify(message));
      });
    });
    const link = await create_room(creator, "Alpha");

    const joiner = await new_page("Bravo");
    await joiner.goto(link);
    await creator.waitForFunction(
      () =>
        !document
          .querySelector("#signaling-tamper")
          ?.classList.contains("d-none"),
      null,
      { timeout: TIMEOUT },
    );
    assert.equal(await creator.textContent("#signaling-tamper-peer"), "Bravo");
    assert.deepEqual(await peer_labels(creator), []);
  });
});
