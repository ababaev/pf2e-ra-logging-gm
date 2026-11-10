#!/usr/bin/env node
/*
 * Headless GM for Foundry VTT.
 *
 * Keeps one GM user (default "Server GM", role Assistant GM) logged into the
 * running world from a headless Chromium, so actions that need "a GM online"
 * keep working when you are not connected. Optionally injects action-logger.js
 * and writes item creations, deletions and quantity changes (coins included)
 * to logs/actions-YYYY-MM-DD.jsonl.
 *
 * It self-heals: server restarts, daily world switches, lost sockets, crashed
 * tabs and page reloads are all detected on the next check and re-joined.
 *
 * Configuration: environment variables (see ecosystem.config.cjs / README.md).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const env = process.env;

const list = (s) =>
  String(s ?? "")
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
const bool = (v, dflt) => (v === undefined || v === "" ? dflt : !/^(0|false|no|off)$/i.test(String(v)));
const home = (p) => (p && p.startsWith("~/") ? path.join(os.homedir(), p.slice(2)) : p);

const CFG = {
  url: (env.FOUNDRY_URL || "http://127.0.0.1:30000").replace(/\/+$/, ""),
  user: env.GM_USER || "Server GM",
  passwordFile: home(env.GM_PASSWORD_FILE || "~/.config/foundry-gm/password"),
  noCanvas: bool(env.NO_CANVAS, true),
  logActions: bool(env.LOG_ACTIONS, true),
  logDir: path.resolve(HERE, home(env.LOG_DIR || "logs")),
  retentionDays: Number(env.LOG_RETENTION_DAYS || 90),
  checkIntervalMs: Number(env.CHECK_INTERVAL_MS || 15_000),
  readyTimeoutMs: Number(env.READY_TIMEOUT_MS || 180_000),
  browserErrors: bool(env.LOG_BROWSER_ERRORS, false),
  logger: {
    socketChannels: list(env.SOCKET_CHANNELS ?? "module.socketlib"),
    maxString: Number(env.MAX_STRING || 300),
  },
};

// ------------------------------------------------------------ small utils

const pad = (n, w = 2) => String(Math.trunc(Math.abs(n))).padStart(w, "0");
const localDay = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const isoLocal = (d = new Date()) => {
  const off = -d.getTimezoneOffset();
  return (
    `${localDay(d)}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}` +
    `${off >= 0 ? "+" : "-"}${pad(off / 60)}:${pad(off % 60)}`
  );
};
const stamp = () => isoLocal().slice(0, 19).replace("T", " ");
const log = (...a) => console.log(stamp(), ...a);
const warn = (...a) => console.warn(stamp(), "WARN", ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const firstLine = (err) => String(err?.message ?? err).split("\n")[0];

let lastStatus = "";
const status = (s) => {
  if (s !== lastStatus) {
    lastStatus = s;
    log(s);
  }
};

// --------------------------------------------------------------- password

function readPassword() {
  if (env.GM_PASSWORD) return env.GM_PASSWORD;
  try {
    return fs.readFileSync(CFG.passwordFile, "utf8").replace(/\r?\n$/, "");
  } catch {
    return "";
  }
}
const PASSWORD = readPassword();
if (!PASSWORD && !bool(env.ALLOW_EMPTY_PASSWORD, false)) {
  console.error(
    `No password for "${CFG.user}". Put it in ${CFG.passwordFile} (chmod 600) or set GM_PASSWORD.\n` +
      "A GM account without a password lets any player log in as GM whenever the bot is offline.",
  );
  process.exit(1);
}

// ------------------------------------------------------------- action log

class ActionLog {
  constructor(dir, retentionDays) {
    this.dir = dir;
    this.retentionDays = retentionDays;
    this.day = null;
    fs.mkdirSync(dir, { recursive: true });
  }

  write(entry) {
    const now = new Date();
    const day = localDay(now);
    if (day !== this.day) {
      this.day = day;
      this.housekeeping().catch((e) => warn("log housekeeping failed:", firstLine(e)));
    }
    fs.appendFileSync(path.join(this.dir, `actions-${day}.jsonl`), `${JSON.stringify({ time: isoLocal(now), ...entry })}\n`);
  }

  // gzip finished days, delete days older than the retention period
  async housekeeping() {
    const today = localDay();
    const cutoff = this.retentionDays > 0 ? localDay(new Date(Date.now() - this.retentionDays * 86_400_000)) : null;
    for (const name of await fs.promises.readdir(this.dir)) {
      const m = /^actions-(\d{4}-\d{2}-\d{2})\.jsonl(\.gz)?$/.exec(name);
      if (!m) continue;
      const [, day, gz] = m;
      const file = path.join(this.dir, name);
      if (cutoff && day < cutoff) {
        await fs.promises.unlink(file);
      } else if (!gz && day < today) {
        await pipeline(fs.createReadStream(file), zlib.createGzip(), fs.createWriteStream(`${file}.gz`));
        await fs.promises.unlink(file);
      }
    }
  }
}

const actionLog = CFG.logActions ? new ActionLog(CFG.logDir, CFG.retentionDays) : null;

function onEntry(entry) {
  if (!actionLog || !entry || typeof entry !== "object") return;
  try {
    actionLog.write(entry);
    if (entry.kind === "logger-start") log(`Action log → ${CFG.logDir}: ${entry.summary}`);
  } catch (err) {
    warn("Could not write action log:", firstLine(err));
  }
}

const LOGGER_SRC = fs
  .readFileSync(path.join(HERE, "action-logger.js"), "utf8")
  .trim()
  .replace(/;\s*$/, "");

// ---------------------------------------------------------------- browser

let browser = null;
let context = null;
let page = null;

async function stopBrowser() {
  const b = browser;
  browser = context = page = null;
  if (b) await b.close().catch(() => {});
}

async function startBrowser() {
  await stopBrowser();
  const args = ["--disable-dev-shm-usage", "--mute-audio", "--no-first-run", "--disable-renderer-backgrounding"];
  if (!CFG.noCanvas) args.push("--enable-unsafe-swiftshader", "--use-angle=swiftshader", "--ignore-gpu-blocklist");

  const b = await chromium.launch({ headless: true, args });
  b.on("disconnected", () => {
    if (browser === b) {
      warn("Chromium exited");
      browser = context = page = null;
    }
  });
  const ctx = await b.newContext({ viewport: { width: 1280, height: 720 }, ignoreHTTPSErrors: true });

  // Client settings live in localStorage and must be set before Foundry boots.
  await ctx.addInitScript((noCanvas) => {
    try {
      localStorage.setItem("core.noCanvas", JSON.stringify(noCanvas));
      if (!noCanvas) {
        localStorage.setItem("core.maxFPS", "10");
        localStorage.setItem("core.performanceMode", "0");
      }
    } catch {
      /* storage unavailable on some error pages */
    }
  }, CFG.noCanvas);
  await ctx.exposeBinding("__gmLog", (_source, entry) => onEntry(entry));

  const p = await ctx.newPage();
  p.on("crash", () => {
    warn("Foundry tab crashed — restarting the browser on the next check");
    if (page === p) page = null;
  });
  p.on("pageerror", (err) => CFG.browserErrors && warn("[page error]", firstLine(err)));
  p.on("console", (msg) => {
    if (CFG.browserErrors && msg.type() === "error") warn("[console]", msg.text().slice(0, 500));
  });

  browser = b;
  context = ctx;
  page = p;
  log(`Chromium started (canvas ${CFG.noCanvas ? "disabled" : "enabled, 10 fps"})`);
}

// ---------------------------------------------------------------- probing

async function serverStatus() {
  try {
    const res = await context.request.get(`${CFG.url}/api/status`, { timeout: 10_000, failOnStatusCode: false });
    return res.ok() ? await res.json() : null;
  } catch {
    return null;
  }
}

async function pageState() {
  try {
    return await page.evaluate(() => {
      const g = globalThis.game;
      const p = location.pathname;
      return {
        path: p,
        ready: g?.ready === true,
        loading: /\/game\/?$/.test(p) && g?.ready !== true,
        user: g?.user?.name ?? null,
        isGM: g?.user?.isGM === true,
        world: g?.world?.id ?? null,
        version: g?.version ?? null,
        system: g?.system ? `${g.system.id} ${g.system.version}` : null,
        socket: g?.socket?.connected === true,
        logger: !!globalThis.__gmActionLogger,
      };
    });
  } catch {
    return null;
  }
}

async function installLogger() {
  const result = await page.evaluate(`(${LOGGER_SRC})(${JSON.stringify(CFG.logger)})`);
  log(`Action logger: ${result}`);
}

// ------------------------------------------------------------------ login

const S = { loginFailures: 0, lastLoginAttempt: 0, loadingSince: 0, disconnectedSince: 0, errors: 0 };

function loginFailed(msg) {
  S.loginFailures++;
  lastStatus = "";
  warn(`${msg}${S.loginFailures >= 3 ? " — will retry every 5 minutes" : ""}`);
}

async function login(server) {
  const backoff = S.loginFailures >= 3 ? 5 * 60_000 : 0;
  if (Date.now() - S.lastLoginAttempt < backoff) return;
  S.lastLoginAttempt = Date.now();
  status(`Joining world "${server.world}" as "${CFG.user}"…`);

  await page.goto(`${CFG.url}/join`, { waitUntil: "domcontentloaded", timeout: 60_000 });
  const landed = new URL(page.url()).pathname;
  if (!/\/join\/?$/.test(landed)) return loginFailed(`/join redirected to ${landed} — is the world running?`);

  // Foundry ≤14.365: <select name="userid">; 14.366+: <input name="username">.
  const nameInput = page.locator('input[name="username"]');
  const userSelect = page.locator('select[name="userid"]');
  await nameInput.or(userSelect).first().waitFor({ timeout: 30_000 });

  let form;
  if (await nameInput.count()) {
    await nameInput.first().fill(CFG.user);
    form = page.locator("form").filter({ has: nameInput }).first();
  } else {
    const pick = await userSelect.first().evaluate((sel, name) => {
      const opt = [...sel.options].find((o) => o.textContent.trim() === name);
      if (!opt) return { found: false, users: [...sel.options].map((o) => o.textContent.trim()).filter(Boolean) };
      opt.disabled = false; // disabled = "already connected"; a stale session of ours after a restart
      sel.value = opt.value;
      sel.dispatchEvent(new Event("change", { bubbles: true }));
      return { found: true };
    }, CFG.user);
    if (!pick.found) {
      return loginFailed(
        `User "${CFG.user}" does not exist in world "${server.world}" (users: ${pick.users.join(", ")}). ` +
          "Create it there with role Assistant GM and the same password.",
      );
    }
    form = page.locator("form").filter({ has: userSelect }).first();
  }

  await form.locator('input[name="password"]').first().fill(PASSWORD);
  await form.locator('button[name="join"], button[type="submit"]').first().click();

  const outcome = await Promise.race([
    page.waitForURL((u) => /\/game\/?$/.test(u.pathname), { timeout: 30_000 }).then(() => "game", () => null),
    page
      .locator("#notifications .notification.error")
      .first()
      .waitFor({ state: "visible", timeout: 30_000 })
      .then(() => "error", () => null),
  ]);
  if (outcome !== "game") {
    const note = await page
      .evaluate(() =>
        [...document.querySelectorAll("#notifications .notification, .notification.error")]
          .map((n) => n.textContent.trim())
          .filter(Boolean)
          .join(" | "),
      )
      .catch(() => "");
    return loginFailed(`Join as "${CFG.user}" was rejected${note ? `: ${note}` : ""} (wrong password?)`);
  }

  await page.waitForFunction(() => globalThis.game?.ready === true, null, { timeout: CFG.readyTimeoutMs });
  S.loginFailures = 0;
  S.loadingSince = 0;
  S.disconnectedSince = 0;
  const s = await pageState();
  log(`Joined "${s?.world}" as "${s?.user}" (Foundry ${s?.version}, ${s?.system})`);
  if (s && !s.isGM) warn(`"${CFG.user}" is not a GM in "${s.world}" — give it the Assistant GM role`);
  if (CFG.logActions) await installLogger();
}

// ------------------------------------------------------------ supervision

async function tick() {
  if (!browser || !page || page.isClosed()) await startBrowser();

  const server = await serverStatus();
  if (!server) return status(`Foundry is not reachable at ${CFG.url} — waiting`);
  if (!server.active) return status("Foundry is up but no world is running — waiting");

  const s = await pageState();
  const now = Date.now();

  if (s?.ready && s.user === CFG.user && s.world === server.world) {
    S.loadingSince = 0;
    if (!s.socket) {
      S.disconnectedSince ||= now;
      if (now - S.disconnectedSince < 45_000) return status("Connection to Foundry lost — waiting for it to reconnect");
      warn("Socket down for 45 s — re-joining");
      S.disconnectedSince = 0;
      return login(server);
    }
    S.disconnectedSince = 0;
    if (CFG.logActions && !s.logger) await installLogger();
    return status(`Online as "${s.user}" in world "${s.world}"${s.isGM ? "" : " (WARNING: not a GM!)"}`);
  }

  if (s?.loading) {
    S.loadingSince ||= now;
    if (now - S.loadingSince < CFG.readyTimeoutMs) return status("World is loading…");
    warn("World did not finish loading in time — re-joining");
  }
  S.loadingSince = 0;
  return login(server);
}

let stopping = false;

async function main() {
  log(
    `Headless GM starting: ${CFG.url} as "${CFG.user}", canvas ${CFG.noCanvas ? "off" : "on"}, ` +
      `action log ${CFG.logActions ? CFG.logDir : "off"}`,
  );
  if (actionLog) await actionLog.housekeeping().catch((e) => warn("log housekeeping failed:", firstLine(e)));

  while (!stopping) {
    try {
      await tick();
      S.errors = 0;
    } catch (err) {
      if (stopping) break;
      S.errors++;
      lastStatus = "";
      warn(`Check failed: ${firstLine(err)}`);
      if (S.errors >= 5) {
        warn("Too many consecutive failures — restarting the browser");
        S.errors = 0;
        await stopBrowser();
      }
    }
    await sleep(CFG.checkIntervalMs);
  }
}

async function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  log(`${signal} received — closing the browser`);
  await stopBrowser();
  process.exit(0);
}
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
