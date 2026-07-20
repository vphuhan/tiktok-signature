#!/usr/bin/env node
/**
 * Generic browser session server.
 *
 * This mirrors the useful part of tiktok-signature for non-TikTok sites:
 * keep a persistent browser profile warm, expose its cookies/fingerprint, and
 * optionally fetch pages/API URLs with that same session.
 *
 * It does not generate TikTok X-Bogus/X-Gnarly signatures.
 */

import http from "http";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import puppeteer from "puppeteer-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function availableStealthEvasions() {
  const evasionsDir = path.join(
    __dirname,
    "node_modules",
    "puppeteer-extra-plugin-stealth",
    "evasions",
  );
  const defaults = StealthPlugin().availableEvasions;
  return new Set(
    [...defaults].filter((evasion) =>
      fs.existsSync(path.join(evasionsDir, evasion, "index.js")),
    ),
  );
}

puppeteer.use(StealthPlugin({ enabledEvasions: availableStealthEvasions() }));

const PORT = Number(process.env.PORT || process.env.SESSION_PORT || 8090);
const START_URL = process.env.SESSION_START_URL || "https://example.com/";
const USER_DATA_DIR =
  process.env.SESSION_USER_DATA_DIR ||
  path.join(__dirname, ".generic-browser-profile");
const HEADLESS = process.env.SESSION_HEADLESS !== "false";
const DEFAULT_UA =
  process.env.SESSION_USER_AGENT ||
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36";
const MAX_SESSION_AGE_MS =
  Number(process.env.MAX_SESSION_AGE_MS) || 30 * 60 * 1000;
const PROXY_ENABLED =
  process.env.PROXY_ENABLED === "true" && process.env.PROXY_HOST;
const PROXY_HOST = process.env.PROXY_HOST || "";
const PROXY_USER = process.env.PROXY_USER || "";
const PROXY_PASS = process.env.PROXY_PASS || "";
const BROWSER_URL = process.env.BROWSER_URL || process.env.CDP_BROWSER_URL || "";
const BROWSER_WS_ENDPOINT =
  process.env.BROWSER_WS_ENDPOINT || process.env.CDP_BROWSER_WS_ENDPOINT || "";

let browser = null;
let page = null;
let isReady = false;
let isInitializing = false;
let lastInitTime = null;
let fetchCount = 0;
let connectedExternalBrowser = false;
let capturedRequests = [];
let capturedResponses = [];
const MAX_CAPTURED_REQUESTS = 100;
const MAX_CAPTURED_RESPONSES = 100;

if (process.argv.includes("--help") || process.argv.includes("-h")) {
  console.log(`Generic browser session server

Usage:
  SESSION_START_URL="https://example.com/" PORT=8090 npm run session

Environment:
  PORT or SESSION_PORT          Server port, default 8090
  SESSION_START_URL             First page to open and seed cookies
  SESSION_USER_DATA_DIR         Persistent browser profile directory
  SESSION_HEADLESS=false        Show Chrome for manual login
  SESSION_USER_AGENT            Override browser user agent
  BROWSER_URL                   Attach to existing Chrome/Brave CDP URL
  BROWSER_WS_ENDPOINT           Attach to existing Chrome/Brave websocket
  MAX_SESSION_AGE_MS            Auto-restart age, default 30 minutes
  PROXY_ENABLED/PROXY_HOST      Optional proxy config

Endpoints:
  GET  /session
  GET  /refresh?url=https://example.com/
  POST /fetch {"url":"https://example.com/api/..."}
  GET  /gia/lookup?reportno=2536614707
  GET  /requests?contains=rdwb.gia.edu
  GET  /health
  GET  /restart?clearProfile=true`);
  process.exit(0);
}

function chromePath() {
  if (process.env.PUPPETEER_EXECUTABLE_PATH) {
    return process.env.PUPPETEER_EXECUTABLE_PATH;
  }
  if (process.platform === "darwin") {
    return "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  }
  if (process.platform === "linux") {
    for (const candidate of [
      "/usr/bin/chromium",
      "/usr/bin/chromium-browser",
      "/usr/bin/google-chrome",
      "/usr/bin/google-chrome-stable",
    ]) {
      try {
        fs.accessSync(candidate);
        return candidate;
      } catch {}
    }
  }
  return undefined;
}

async function initBrowser() {
  if (isInitializing) {
    while (isInitializing) {
      await new Promise((r) => setTimeout(r, 100));
    }
    return;
  }
  if (isReady && browser && page) return;

  isInitializing = true;
  try {
    fs.mkdirSync(USER_DATA_DIR, { recursive: true });

    const args = [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-blink-features=AutomationControlled",
      "--window-size=1920,1080",
    ];
    if (PROXY_ENABLED) args.push(`--proxy-server=http://${PROXY_HOST}`);

    if (BROWSER_WS_ENDPOINT || BROWSER_URL) {
      connectedExternalBrowser = true;
      browser = await puppeteer.connect({
        ...(BROWSER_WS_ENDPOINT
          ? { browserWSEndpoint: BROWSER_WS_ENDPOINT }
          : { browserURL: BROWSER_URL }),
        defaultViewport: null,
      });
      const pages = await browser.pages();
      page =
        pages.find((candidate) =>
          candidate.url().startsWith("https://www.gia.edu/"),
        ) ||
        pages.find((candidate) => candidate.url() !== "about:blank") ||
        pages[0] ||
        (await browser.newPage());
    } else {
      connectedExternalBrowser = false;
      browser = await puppeteer.launch({
        headless: HEADLESS ? "new" : false,
        executablePath: chromePath(),
        args,
        userDataDir: USER_DATA_DIR,
        ignoreDefaultArgs: ["--enable-automation"],
      });

      page = await browser.newPage();
    }
    page.on("request", (request) => {
      const entry = {
        capturedAt: new Date().toISOString(),
        capturedAtMs: Date.now(),
        method: request.method(),
        url: request.url(),
        resourceType: request.resourceType(),
        headers: request.headers(),
      };
      capturedRequests.push(entry);
      if (capturedRequests.length > MAX_CAPTURED_REQUESTS) {
        capturedRequests = capturedRequests.slice(-MAX_CAPTURED_REQUESTS);
      }
    });
    page.on("response", async (response) => {
      const url = response.url();
      if (!url.includes("rdwb.gia.edu")) return;
      let body = "";
      try {
        body = await response.text();
      } catch {}
      const entry = {
        capturedAt: new Date().toISOString(),
        capturedAtMs: Date.now(),
        url,
        status: response.status(),
        headers: response.headers(),
        body,
      };
      capturedResponses.push(entry);
      if (capturedResponses.length > MAX_CAPTURED_RESPONSES) {
        capturedResponses = capturedResponses.slice(-MAX_CAPTURED_RESPONSES);
      }
    });
    if (!connectedExternalBrowser && PROXY_ENABLED && PROXY_USER && PROXY_PASS) {
      await page.authenticate({ username: PROXY_USER, password: PROXY_PASS });
    }
    if (!connectedExternalBrowser) {
      await page.setUserAgent(DEFAULT_UA);
      await page.setViewport({ width: 1920, height: 1080 });
      await page.evaluateOnNewDocument(() => {
        Object.defineProperty(navigator, "platform", {
          get: () => "MacIntel",
          configurable: true,
        });
      });
    }

    if (!page.url().startsWith("https://www.gia.edu/") && page.url() !== START_URL) {
      await warmup(START_URL);
    }
    lastInitTime = new Date().toISOString();
    isReady = true;
    console.log(`[Session] Ready at ${page.url()}`);
  } finally {
    isInitializing = false;
  }
}

async function closeBrowser({ clearProfile = false } = {}) {
  isReady = false;
  lastInitTime = null;
  fetchCount = 0;
  const wasExternalBrowser = connectedExternalBrowser;
  if (browser) {
    try {
      if (wasExternalBrowser) {
        await browser.disconnect();
      } else {
        await browser.close();
      }
    } catch (e) {
      console.error("[Session] Browser close failed:", e.message);
    }
  }
  browser = null;
  page = null;
  connectedExternalBrowser = false;

  if (clearProfile && !wasExternalBrowser && fs.existsSync(USER_DATA_DIR)) {
    fs.rmSync(USER_DATA_DIR, { recursive: true, force: true });
  }
}

async function ensureReady() {
  if (!browser || !page) {
    await initBrowser();
    return;
  }
  if (lastInitTime && Date.now() - new Date(lastInitTime).getTime() > MAX_SESSION_AGE_MS) {
    await closeBrowser();
    await initBrowser();
    return;
  }
  try {
    await page.title();
  } catch {
    await closeBrowser();
    await initBrowser();
  }
}

async function warmup(url) {
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
  await new Promise((r) => setTimeout(r, 2000));
}

async function sessionData() {
  await ensureReady();
  const cookies = await page.cookies();
  const navigatorData = await page.evaluate(() => ({
    user_agent: navigator.userAgent,
    platform: navigator.platform,
    browser_language: navigator.language,
    languages: navigator.languages,
    cookie_enabled: navigator.cookieEnabled,
    webdriver: navigator.webdriver,
    screen_width: window.screen.width,
    screen_height: window.screen.height,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  }));
  return {
    url: page.url(),
    cookies: cookies.map((c) => `${c.name}=${c.value}`).join("; "),
    cookie_items: cookies,
    navigator: navigatorData,
  };
}

async function cookiesFor(urls) {
  await ensureReady();
  const targetUrls = urls.length ? urls : [page.url()];
  const cookies = await page.cookies(...targetUrls);
  return {
    urls: targetUrls,
    cookies: cookies.map((c) => `${c.name}=${c.value}`).join("; "),
    cookie_items: cookies,
  };
}

async function giaLookup(reportNo) {
  await ensureReady();
  const startedAtMs = Date.now();
  const landingUrl = "https://www.gia.edu/report-check-landing";

  if (!page.url().startsWith("https://www.gia.edu/")) {
    await page.goto(landingUrl, {
      waitUntil: "domcontentloaded",
      timeout: 60000,
    });
  }

  const browserResult = await page.evaluate(async (reportNo) => {
    const token = document.cookie
      .split("; ")
      .find((entry) => entry.startsWith("rdwb-token="))
      ?.split("=")
      .slice(1)
      .join("=");

    const url = new URL("https://rdwb.gia.edu/");
    url.searchParams.set("reportno", reportNo);
    url.searchParams.set("locale", "en_US");
    url.searchParams.set("env", "prod");
    url.searchParams.set("USEREG", "1");
    url.searchParams.set("qr", "false");

    const response = await fetch(url.toString(), {
      method: "GET",
      credentials: "include",
      headers: {
        accept: "application/json",
        "cache-control": "no-cache",
        pragma: "no-cache",
        ...(token ? { "rdwb-token": token } : {}),
      },
    });
    const text = await response.text();
    let data = text;
    try {
      data = JSON.parse(text);
    } catch {}

    return {
      ok: response.ok,
      status: response.status,
      statusText: response.statusText,
      url: response.url,
      rdwbToken: token || null,
      bodyLength: text.length,
      data,
    };
  }, reportNo);

  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const rdwbRequest = capturedRequests.find(
      (entry) =>
        entry.capturedAtMs >= startedAtMs && entry.url.includes("rdwb.gia.edu"),
    );
    if (rdwbRequest) break;
    await new Promise((r) => setTimeout(r, 250));
  }
  await new Promise((r) => setTimeout(r, 1000));

  const requests = capturedRequests.filter(
    (entry) =>
      entry.capturedAtMs >= startedAtMs && entry.url.includes("rdwb.gia.edu"),
  );
  const responses = capturedResponses.filter(
    (entry) =>
      entry.capturedAtMs >= startedAtMs && entry.url.includes("rdwb.gia.edu"),
  );
  const lastRequest = requests.length ? requests[requests.length - 1] : null;
  const lastResponse = responses.length ? responses[responses.length - 1] : null;

  return {
    pageUrl: page.url(),
    reportNo,
    ok: browserResult.ok,
    httpStatus: browserResult.status,
    statusText: browserResult.statusText,
    rdwbToken: browserResult.rdwbToken || lastRequest?.headers?.["rdwb-token"] || null,
    cookie: lastRequest?.headers?.cookie || null,
    data: browserResult.data,
    request: lastRequest,
    response: lastResponse,
  };
}

async function browserFetch(targetUrl, options = {}) {
  await ensureReady();
  const accept =
    options.accept ||
    "application/json,text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8";
  const referer = options.referer || page.url() || START_URL;
  const method = options.method || "GET";
  const body = options.body;
  const extraHeaders = options.headers || {};

  const session = await sessionData();
  const response = await fetch(targetUrl, {
    method,
    body,
    headers: {
      "User-Agent": session.navigator.user_agent || DEFAULT_UA,
      Cookie: session.cookies || "",
      Accept: accept,
      Referer: referer,
      ...extraHeaders,
    },
  });
  const text = await response.text();
  const contentType = response.headers.get("content-type") || "";
  let data = text;
  const trimmed = text.trim();
  if (
    trimmed &&
    (contentType.includes("application/json") ||
      trimmed.startsWith("{") ||
      trimmed.startsWith("["))
  ) {
    try {
      data = JSON.parse(text);
    } catch {}
  }
  fetchCount += 1;
  return {
    httpStatus: response.status,
    statusText: response.statusText,
    contentType,
    responseUrl: response.url,
    bodyLength: text.length,
    data,
  };
}

async function readJsonBody(req) {
  let body = "";
  for await (const chunk of req) body += chunk;
  if (!body.trim()) return {};
  try {
    return JSON.parse(body);
  } catch {
    return { url: body.trim() };
  }
}

async function handleRequest(req, res) {
  const requestUrl = new URL(req.url, `http://localhost:${PORT}`);
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Content-Type", "application/json");

  if (req.method === "OPTIONS") {
    res.writeHead(200);
    res.end();
    return;
  }

  try {
    if (requestUrl.pathname === "/health") {
      const ageMs = lastInitTime ? Date.now() - new Date(lastInitTime).getTime() : 0;
      res.writeHead(200);
      res.end(
        JSON.stringify({
          status: "ok",
          ready: isReady,
          initializing: isInitializing,
          startUrl: START_URL,
          currentUrl: page ? page.url() : null,
          sessionAgeMinutes: Math.round(ageMs / 60000),
          maxSessionAgeMinutes: MAX_SESSION_AGE_MS / 60000,
          fetchCount,
          headless: HEADLESS,
          proxyEnabled: !!PROXY_ENABLED,
          connectedExternalBrowser,
        }),
      );
      return;
    }

    if (requestUrl.pathname === "/session") {
      res.writeHead(200);
      res.end(JSON.stringify({ status: "ok", data: await sessionData() }));
      return;
    }

    if (requestUrl.pathname === "/cookies") {
      const urls = requestUrl.searchParams.getAll("url");
      res.writeHead(200);
      res.end(JSON.stringify({ status: "ok", data: await cookiesFor(urls) }));
      return;
    }

    if (requestUrl.pathname === "/requests") {
      const contains = requestUrl.searchParams.get("contains");
      const limit = Number(requestUrl.searchParams.get("limit") || 20);
      let data = capturedRequests;
      if (contains) {
        data = data.filter((entry) => entry.url.includes(contains));
      }
      res.writeHead(200);
      res.end(JSON.stringify({ status: "ok", data: data.slice(-limit) }));
      return;
    }

    if (requestUrl.pathname === "/responses") {
      const contains = requestUrl.searchParams.get("contains");
      const limit = Number(requestUrl.searchParams.get("limit") || 20);
      let data = capturedResponses;
      if (contains) {
        data = data.filter((entry) => entry.url.includes(contains));
      }
      res.writeHead(200);
      res.end(JSON.stringify({ status: "ok", data: data.slice(-limit) }));
      return;
    }

    if (requestUrl.pathname === "/gia/lookup") {
      const reportNo = requestUrl.searchParams.get("reportno");
      if (!reportNo) {
        res.writeHead(400);
        res.end(
          JSON.stringify({ status: "error", message: "reportno is required" }),
        );
        return;
      }
      const data = await giaLookup(reportNo);
      res.writeHead(200);
      res.end(JSON.stringify({ status: "ok", data }));
      return;
    }

    if (requestUrl.pathname === "/refresh") {
      const targetUrl = requestUrl.searchParams.get("url") || START_URL;
      await ensureReady();
      await warmup(targetUrl);
      res.writeHead(200);
      res.end(JSON.stringify({ status: "ok", data: await sessionData() }));
      return;
    }

    if (requestUrl.pathname === "/fetch" && req.method === "POST") {
      const body = await readJsonBody(req);
      if (!body.url) {
        res.writeHead(400);
        res.end(JSON.stringify({ status: "error", message: "URL is required" }));
        return;
      }
      const result = await browserFetch(body.url, body);
      res.writeHead(200);
      res.end(JSON.stringify({ status: "ok", ...result }));
      return;
    }

    if (requestUrl.pathname === "/restart") {
      const clearProfile = requestUrl.searchParams.get("clearProfile") === "true";
      await closeBrowser({ clearProfile });
      await initBrowser();
      res.writeHead(200);
      res.end(JSON.stringify({ status: "ok", message: "Browser restarted" }));
      return;
    }

    res.writeHead(404);
    res.end(JSON.stringify({ status: "error", message: "Not found" }));
  } catch (e) {
    console.error("[Session] Error:", e.message);
    res.writeHead(500);
    res.end(JSON.stringify({ status: "error", message: e.message }));
  }
}

const server = http.createServer(handleRequest);
server.listen(PORT, () => {
  console.log(`[Session] Browser session server running on port ${PORT}`);
  console.log(`[Session] START_URL=${START_URL}`);
  console.log("[Session] Endpoints: GET /session, GET /cookies, GET /requests, GET /responses, GET /gia/lookup, GET /refresh, POST /fetch, GET /health, GET /restart");
  initBrowser().catch((e) => console.error("[Session] Init failed:", e.message));
});

process.on("SIGINT", async () => {
  await closeBrowser();
  process.exit(0);
});

process.on("SIGTERM", async () => {
  await closeBrowser();
  process.exit(0);
});
