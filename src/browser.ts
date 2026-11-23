import { type ChildProcess, execFile, execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createConnection, createServer } from "node:net";
import { join, resolve } from "node:path";
import type { ReaCallResult, ReaTool } from "./rea.js";
import { asRecord, asString } from "./values.js";
import { abortable, ConcurrencyLimiter, deadlineSignal } from "./concurrency.js";
import { setTimeout as delay } from "node:timers/promises";
import { BrowserContextStore } from "./browserContext.js";
import { UncertainInvocationError } from "./execution.js";
import { resources } from "./resources.js";
import { signalOwnedProcess, terminateOwnedProcess } from "./ownedProcess.js";
import { findOnPath, hostHome } from "./platform.js";
import { desktopBrowserPaths } from "./platformDesktop.js";

export type BrowserEngineId =
  | "camofox"
  | "chromium"
  | "firefox"
  | "zen"
  | "chrome"
  | "brave";
export type BrowserNetworkMode = "direct" | "proxy" | "tor";

export interface InstalledBrowserInfo {
  readonly id: Exclude<BrowserEngineId, "camofox">;
  readonly name: string;
  readonly family: "chromium" | "firefox";
  readonly binary: string | null;
}

export interface CamofoxConfig {
  readonly baseUrl: string;
  readonly userId: string;
  readonly sessionKey: string;
  readonly accessKey: string;
  readonly apiKey: string;
  readonly cookiesDir: string;
  readonly source: string;
}

export interface CamofoxHealth {
  readonly reachable: boolean;
  readonly baseUrl: string;
  readonly source: string;
  readonly engine: string | null;
  readonly browserRunning: boolean;
  readonly activeTabs: number;
  readonly activeSessions: number;
  readonly containerState: "running" | "stopped" | "absent" | "unknown";
  readonly error?: string | undefined;
}

export interface TorStatus {
  readonly available: boolean;
  readonly proxyUrl: string;
  readonly port: number | null;
  readonly source: string;
}

export interface RunningLocalBrowser {
  readonly engine: Exclude<BrowserEngineId, "camofox">;
  readonly binary: string;
  readonly pid: number;
  readonly cdpPort: number;
  readonly cdpUrl: string;
  readonly profileDir: string;
  readonly headless: boolean;
  readonly networkMode: BrowserNetworkMode;
  readonly proxyUrl: string | null;
  readonly startedAt: string;
  readonly lastUrl: string | null;
}

export interface BrowserStatusSnapshot {
  readonly preferredEngine: BrowserEngineId;
  readonly networkMode: BrowserNetworkMode;
  readonly proxyUrl: string | null;
  readonly camofox: CamofoxHealth;
  readonly tor: TorStatus;
  readonly installed: readonly InstalledBrowserInfo[];
  readonly activeLocal: RunningLocalBrowser | null;
  readonly camofoxRouting: CamofoxRouting;
}

export interface CamofoxRouting {
  readonly supported: false;
  readonly applied: false;
  readonly verified: false;
  readonly managedBy: "server";
  readonly requestedMode: BrowserNetworkMode;
  readonly reason: string;
}

export interface BrowserExecutionRecorder {
  invoke<T>(tool: string, args: Record<string, unknown>, readOnly: boolean, work: () => Promise<T>, signal?: AbortSignal): Promise<T>;
}

export interface LaunchBrowserOptions {
  readonly engine?: Exclude<BrowserEngineId, "camofox"> | undefined;
  readonly url?: string | undefined;
  readonly headless?: boolean | undefined;
  readonly networkMode?: BrowserNetworkMode | undefined;
  readonly proxyUrl?: string | null | undefined;
  readonly cdpPort?: number | undefined;
}

const SEARCH_MACROS = [
  "@google_search",
  "@youtube_search",
  "@amazon_search",
  "@reddit_search",
  "@wikipedia_search",
  "@twitter_search",
  "@yelp_search",
  "@spotify_search",
  "@netflix_search",
  "@linkedin_search",
  "@instagram_search",
  "@tiktok_search",
  "@twitch_search",
] as const;

const BROWSER_CANDIDATES: ReadonlyArray<{
  id: Exclude<BrowserEngineId, "camofox">;
  name: string;
  family: "chromium" | "firefox";
  paths: readonly string[];
}> = [
  {
    id: "chromium",
    name: "Chromium",
    family: "chromium",
    paths: [
      "/usr/bin/chromium",
      "/usr/bin/chromium-browser",
      "/snap/bin/chromium",
    ],
  },
  {
    id: "firefox",
    name: "Mozilla Firefox",
    family: "firefox",
    paths: ["/usr/bin/firefox", "/snap/bin/firefox"],
  },
  {
    id: "zen",
    name: "Zen Browser",
    family: "firefox",
    paths: ["/usr/bin/zen-browser", "/usr/bin/zen", "/opt/zen-browser/zen"],
  },
  {
    id: "chrome",
    name: "Google Chrome",
    family: "chromium",
    paths: ["/usr/bin/google-chrome", "/usr/bin/google-chrome-stable"],
  },
  {
    id: "brave",
    name: "Brave Browser",
    family: "chromium",
    paths: ["/usr/bin/brave-browser", "/usr/bin/brave"],
  },
];

const buildReaTool = (
  name: string,
  description: string,
  inputSchema: Record<string, unknown>,
  readOnly: boolean,
): ReaTool => {
  const firstNl = description.indexOf("\n");
  const firstLine = firstNl >= 0 ? description.slice(0, firstNl) : description;
  const summaryLine =
    firstLine.length <= 150 ? firstLine : `${firstLine.slice(0, 149)}…`;
  return {
    name,
    description,
    summaryLine,
    searchKey: `${name}\n${description}`.toLowerCase(),
    nameTokens: name
      .toLowerCase()
      .split(/[_\W]+/)
      .filter(Boolean),
    inputSchema,
    readOnly,
  };
};

/**
 * Canonical Camoufox anti-detection browser MCP tools (`camofox_*`) + `omr_browser`
 * multi-browser/proxy/Tor controller exposed directly through ReaBroker.
 */
export const BROWSER_TOOLS: readonly ReaTool[] = Object.freeze([
  buildReaTool(
    "camofox_create_tab",
    "PREFERRED FOR ANTI-BOT / CLOUDFLARE / CAPTCHA: Create a new browser tab in the Camoufox stealth anti-detection browser (Docker/MCP). Returns tabId for snapshot, click, type, evaluate, and navigate calls.",
    {
      type: "object",
      properties: {
        url: { type: "string", description: "Initial URL to navigate to." },
      },
      required: ["url"],
    },
    false,
  ),
  buildReaTool(
    "camofox_snapshot",
    "Get accessibility DOM snapshot of a Camoufox tab with interactive element refs (e1, e2, …) and save a visual screenshot to the session directory.",
    {
      type: "object",
      properties: {
        tabId: {
          type: "string",
          description:
            "Tab identifier from camofox_create_tab or camofox_list_tabs.",
        },
        offset: {
          type: "number",
          description:
            "Character offset for paginated snapshots (use nextOffset when hasMore=true).",
        },
      },
      required: ["tabId"],
    },
    true,
  ),
  buildReaTool(
    "camofox_click",
    "Click an element in a Camoufox tab by snapshot ref (e.g. e1) or CSS selector.",
    {
      type: "object",
      properties: {
        tabId: { type: "string", description: "Tab identifier." },
        ref: {
          type: "string",
          description: "Element ref from camofox_snapshot (e.g. e1).",
        },
        selector: {
          type: "string",
          description: "CSS selector (alternative to ref).",
        },
      },
      required: ["tabId"],
    },
    false,
  ),
  buildReaTool(
    "camofox_type",
    "Type text into an input element in a Camoufox tab by ref or CSS selector.",
    {
      type: "object",
      properties: {
        tabId: { type: "string", description: "Tab identifier." },
        ref: {
          type: "string",
          description: "Element ref from camofox_snapshot (e.g. e2).",
        },
        selector: {
          type: "string",
          description: "CSS selector (alternative to ref).",
        },
        text: { type: "string", description: "Text to type." },
        pressEnter: {
          type: "boolean",
          description: "Press Enter after typing.",
        },
      },
      required: ["tabId", "text"],
    },
    false,
  ),
  buildReaTool(
    "camofox_navigate",
    "Navigate a Camoufox tab to a URL or execute a search macro (@google_search, @youtube_search, @reddit_search, …). Bypasses Cloudflare/CAPTCHA bot detection.",
    {
      type: "object",
      properties: {
        tabId: { type: "string", description: "Tab identifier." },
        url: { type: "string", description: "URL to navigate to." },
        macro: {
          type: "string",
          description: "Search macro (e.g. @google_search, @youtube_search).",
          enum: [...SEARCH_MACROS],
        },
        query: {
          type: "string",
          description: "Search query when using macro.",
        },
      },
      required: ["tabId"],
    },
    false,
  ),
  buildReaTool(
    "camofox_scroll",
    "Scroll a Camoufox browser tab up, down, left, or right.",
    {
      type: "object",
      properties: {
        tabId: { type: "string", description: "Tab identifier." },
        direction: { type: "string", enum: ["up", "down", "left", "right"] },
        amount: { type: "number", description: "Pixels to scroll." },
      },
      required: ["tabId", "direction"],
    },
    false,
  ),
  buildReaTool(
    "camofox_screenshot",
    "Capture a visual PNG screenshot of a Camoufox tab and save it to <session>/screenshots/.",
    {
      type: "object",
      properties: {
        tabId: { type: "string", description: "Tab identifier." },
      },
      required: ["tabId"],
    },
    true,
  ),
  buildReaTool(
    "camofox_close_tab",
    "Close an open Camoufox browser tab.",
    {
      type: "object",
      properties: {
        tabId: { type: "string", description: "Tab identifier." },
      },
      required: ["tabId"],
    },
    false,
  ),
  buildReaTool(
    "camofox_evaluate",
    "Execute JavaScript in a Camoufox tab's page context and return the result (inspect window globals, storage, tokens, API clients, or DOM state).",
    {
      type: "object",
      properties: {
        tabId: { type: "string", description: "Tab identifier." },
        expression: {
          type: "string",
          description: "JavaScript expression to evaluate in page context.",
        },
      },
      required: ["tabId", "expression"],
    },
    false,
  ),
  buildReaTool(
    "camofox_list_tabs",
    "List all open Camoufox tabs for the active session.",
    {
      type: "object",
      properties: {},
    },
    true,
  ),
  buildReaTool(
    "camofox_import_cookies",
    "Import Netscape-format cookies into the active Camoufox session.",
    {
      type: "object",
      properties: {
        cookiesPath: {
          type: "string",
          description: "Path to a Netscape cookies.txt file.",
        },
        domainSuffix: {
          type: "string",
          description: "Optional domain suffix filter.",
        },
      },
      required: ["cookiesPath"],
    },
    false,
  ),
  buildReaTool(
    "omr_browser",
    "Manage OMR's multi-browser & network routing hub: inspect status, start Camoufox (Docker anti-detect), or launch real local browsers (chromium, firefox, zen, chrome, brave) with direct, HTTP/SOCKS5 proxy, or Tor (socks5h://127.0.0.1:9050) routing and a loopback CDP port for REA's inspect_web_page / observe_web_session tools.",
    {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["status", "context", "select", "launch", "open", "proxy", "tor", "close"],
          description: "Operation to perform.",
        },
        tabId: { type: "string", description: "Observed tab to select with action=select" },
        engine: {
          type: "string",
          enum: ["camofox", "chromium", "firefox", "zen", "chrome", "brave"],
          description: "Browser engine to select or launch.",
        },
        url: {
          type: "string",
          description: "Target URL to open (for launch/open).",
        },
        proxy: {
          type: "string",
          description:
            "Proxy URL (e.g. socks5h://127.0.0.1:9050, http://127.0.0.1:8080, or 'off').",
        },
        tor: {
          type: "boolean",
          description:
            "Route browser traffic & DNS through the Tor network (socks5h).",
        },
        headless: {
          type: "boolean",
          description:
            "Run local browser headless (default true; pass false for visible GUI window).",
        },
      },
      required: ["action"],
    },
    false,
  ),
]);

export const BROWSER_TOOL_NAMES: readonly string[] = Object.freeze(
  BROWSER_TOOLS.map((t) => t.name),
);

/** Discover installed local browsers (`chromium`, `firefox`, `zen`, `chrome`, `brave`). */
export const discoverInstalledBrowsers = (env = process.env, platform = process.platform, exists = existsSync): InstalledBrowserInfo[] =>
  BROWSER_CANDIDATES.map((candidate) => {
    const paths = platform === "linux" ? candidate.paths : desktopBrowserPaths(candidate.id, env, platform);
    const found = paths.find(exists) ?? (platform !== "linux" ? findOnPath(candidate.id, env, platform, exists, true) : undefined) ?? null;
    return {
      id: candidate.id,
      name: candidate.name,
      family: candidate.family,
      binary: found,
    };
  });

/**
 * Discover `camofox-browser` configuration from environment variables or `~/.omp/agent/mcp.json`.
 */
export const resolveCamofoxConfig = (
  env: NodeJS.ProcessEnv = process.env,
): CamofoxConfig => {
  let ompEnv: Record<string, string> = {};
  let source = "default (127.0.0.1:9377)";
  const ompMcpPath = join(hostHome(env), ".omp", "agent", "mcp.json");
  if (existsSync(ompMcpPath)) {
    try {
      const raw = JSON.parse(readFileSync(ompMcpPath, "utf8")) as unknown;
      const servers = asRecord(asRecord(raw)?.["mcpServers"]);
      const camofoxEntry =
        asRecord(servers?.["camofox"]) ??
        asRecord(servers?.["camofox-browser"]);
      const entryEnv = asRecord(camofoxEntry?.["env"]);
      if (entryEnv) {
        for (const [k, v] of Object.entries(entryEnv)) {
          if (typeof v === "string") ompEnv[k] = v;
        }
        source = ompMcpPath;
      }
    } catch {
      // Ignore malformed external mcp.json
    }
  }

  const port =
    Number.parseInt(
      env["CAMOFOX_PORT"] || ompEnv["CAMOFOX_PORT"] || "9377",
      10,
    ) || 9377;
  const rawBaseUrl =
    env["CAMOFOX_BASE_URL"] ||
    ompEnv["CAMOFOX_BASE_URL"] ||
    `http://127.0.0.1:${port}`;
  if (env["CAMOFOX_BASE_URL"] || env["CAMOFOX_PORT"]) {
    source = "environment (CAMOFOX_*)";
  }

  return {
    baseUrl: rawBaseUrl.replace(/\/+$/, ""),
    userId:
      env["CAMOFOX_USER_ID"] ||
      ompEnv["CAMOFOX_USER_ID"] ||
      `omr-${randomUUID().slice(0, 8)}`,
    sessionKey:
      env["CAMOFOX_SESSION_KEY"] || ompEnv["CAMOFOX_SESSION_KEY"] || "default",
    accessKey: (
      env["CAMOFOX_ACCESS_KEY"] ||
      ompEnv["CAMOFOX_ACCESS_KEY"] ||
      ""
    ).trim(),
    apiKey: (env["CAMOFOX_API_KEY"] || ompEnv["CAMOFOX_API_KEY"] || "").trim(),
    cookiesDir:
      env["CAMOFOX_COOKIES_DIR"] ||
      ompEnv["CAMOFOX_COOKIES_DIR"] ||
      join(hostHome(env), ".camofox", "cookies"),
    source,
  };
};

const checkTcpPort = (
  host: string,
  port: number,
  timeoutMs = 450,
): Promise<boolean> =>
  new Promise<boolean>((resolvePort) => {
    const socket = createConnection({ host, port });
    let settled = false;
    const finish = (ok: boolean): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolvePort(ok);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
  });

const allocateFreePort = (preferred = 0): Promise<number> =>
  new Promise<number>((resolvePort, rejectPort) => {
    const tryListen = (port: number): void => {
      const srv = createServer();
      srv.unref();
      srv.once("error", () => {
        if (port !== 0) tryListen(0);
        else rejectPort(new Error("unable to allocate loopback CDP port"));
      });
      srv.listen(port, "127.0.0.1", () => {
        const addr = srv.address();
        const chosen = typeof addr === "object" && addr ? addr.port : preferred;
        srv.close(() => resolvePort(chosen));
      });
    };
    tryListen(preferred);
  });

/** Probe whether a local Tor SOCKS5 listener is reachable on 9050, 9150, or `OMR_TOR_PROXY`. */
export const probeTorStatus = async (
  env: NodeJS.ProcessEnv = process.env,
): Promise<TorStatus> => {
  const custom = (env["OMR_TOR_PROXY"] ?? "").trim();
  if (custom) {
    const portMatch = /:(\d+)$/.exec(custom);
    const port = portMatch ? Number(portMatch[1]) : null;
    const reachable = port ? await checkTcpPort("127.0.0.1", port) : true;
    return {
      available: reachable,
      proxyUrl: custom,
      port,
      source: "OMR_TOR_PROXY",
    };
  }
  if (await checkTcpPort("127.0.0.1", 9050)) {
    return {
      available: true,
      proxyUrl: "socks5h://127.0.0.1:9050",
      port: 9050,
      source: "tor daemon (127.0.0.1:9050)",
    };
  }
  if (await checkTcpPort("127.0.0.1", 9150)) {
    return {
      available: true,
      proxyUrl: "socks5h://127.0.0.1:9150",
      port: 9150,
      source: "Tor Browser SOCKS (127.0.0.1:9150)",
    };
  }
  return {
    available: false,
    proxyUrl: "socks5h://127.0.0.1:9050",
    port: 9050,
    source:
      process.platform === "linux" ? "inactive (start with `sudo systemctl start tor` or set OMR_TOR_PROXY)" : "inactive (start Tor or set OMR_TOR_PROXY)",
  };
};

const inspectCamofoxDockerState = ():
  | "running"
  | "stopped"
  | "absent"
  | "unknown" => {
  try {
    const out = execFileSync(
      "docker",
      ["inspect", "-f", "{{.State.Running}}", "camofox-browser"],
      {
        encoding: "utf8",
        timeout: 1_500,
        stdio: ["ignore", "pipe", "ignore"],
      },
    ).trim();
    return out === "true" ? "running" : "stopped";
  } catch {
    return "absent";
  }
};

/** Probe the `camofox-browser` REST health endpoint (`/health`). */
export const probeCamofoxHealth = async (
  config = resolveCamofoxConfig(),
  signal?: AbortSignal,
): Promise<CamofoxHealth> => {
  signal?.throwIfAborted();
  const containerState = inspectCamofoxDockerState();
  try {
    const res = await fetch(`${config.baseUrl}/health`, {
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(1_800)]) : AbortSignal.timeout(1_800),
    });
    if (!res.ok) {
      return {
        reachable: false,
        baseUrl: config.baseUrl,
        source: config.source,
        engine: null,
        browserRunning: false,
        activeTabs: 0,
        activeSessions: 0,
        containerState,
        error: `HTTP ${res.status}`,
      };
    }
    const data = asRecord(await res.json());
    return {
      reachable: data?.["ok"] === true,
      baseUrl: config.baseUrl,
      source: config.source,
      engine: asString(data?.["engine"]) || "camoufox",
      browserRunning: data?.["browserRunning"] === true,
      activeTabs:
        typeof data?.["activeTabs"] === "number" ? data["activeTabs"] : 0,
      activeSessions:
        typeof data?.["activeSessions"] === "number"
          ? data["activeSessions"]
          : 0,
      containerState: containerState === "absent" ? "running" : containerState,
    };
  } catch (error) {
    signal?.throwIfAborted();
    return {
      reachable: false,
      baseUrl: config.baseUrl,
      source: config.source,
      engine: null,
      browserRunning: false,
      activeTabs: 0,
      activeSessions: 0,
      containerState,
      error: error instanceof Error ? error.message : String(error),
    };
  }
};

/**
 * Parse a Netscape cookie file into Playwright-compatible cookie objects for `camofox_import_cookies`.
 */
const parseNetscapeCookies = (
  raw: string,
  domainSuffix?: string,
): Array<Record<string, unknown>> => {
  const cookies: Array<Record<string, unknown>> = [];
  for (const rawLine of raw.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || (line.startsWith("#") && !line.startsWith("#HttpOnly_")))
      continue;
    let httpOnly = false;
    let body = line;
    if (body.startsWith("#HttpOnly_")) {
      httpOnly = true;
      body = body.slice("#HttpOnly_".length);
    }
    const parts = body.split("\t");
    if (parts.length < 7) continue;
    const [domain, , path, secureRaw, expiresRaw, name, value] = parts;
    if (!domain || !name) continue;
    if (domainSuffix && !domain.endsWith(domainSuffix)) continue;
    const expires = Number(expiresRaw);
    cookies.push({
      name,
      value: value ?? "",
      domain,
      path: path || "/",
      secure: secureRaw?.toUpperCase() === "TRUE",
      httpOnly,
      ...(Number.isFinite(expires) && expires > 0 ? { expires } : {}),
    });
  }
  return cookies;
};

/**
 * Format Firefox/Zen `user.js` preferences for CDP remote debugging and optional SOCKS5/Tor/HTTP proxy.
 */
export const buildFirefoxProfilePrefs = (
  cdpPort: number,
  networkMode: BrowserNetworkMode,
  proxyUrl: string | null,
): string => {
  const lines: string[] = [
    "// Generated by OMR (oh-my-rea) for isolated reverse-engineering browser sessions",
    `user_pref("devtools.debugger.remote-enabled", true);`,
    `user_pref("devtools.debugger.prompt-connection", false);`,
    `user_pref("devtools.chrome.enabled", true);`,
    `user_pref("toolkit.startup.max_resumed_crashes", -1);`,
    `user_pref("browser.shell.checkDefaultBrowser", false);`,
    `user_pref("datareporting.policy.dataSubmissionEnabled", false);`,
    `user_pref("remote.active-protocols", 3);`,
    `// CDP port: ${cdpPort}`,
  ];

  const effectiveProxy =
    networkMode === "tor"
      ? proxyUrl || "socks5h://127.0.0.1:9050"
      : networkMode === "proxy"
        ? proxyUrl
        : null;
  if (effectiveProxy) {
    try {
      const parsed = new URL(
        effectiveProxy.includes("://")
          ? effectiveProxy
          : `http://${effectiveProxy}`,
      );
      const proto = parsed.protocol.replace(":", "").toLowerCase();
      const host = parsed.hostname || "127.0.0.1";
      const port =
        Number(parsed.port) || (proto.startsWith("socks") ? 9050 : 8080);
      lines.push(`user_pref("network.proxy.type", 1);`);
      if (proto.startsWith("socks")) {
        lines.push(
          `user_pref("network.proxy.socks", ${JSON.stringify(host)});`,
        );
        lines.push(`user_pref("network.proxy.socks_port", ${port});`);
        lines.push(`user_pref("network.proxy.socks_version", 5);`);
        // Prevent DNS leaks and enable .onion resolution when using Tor / socks5h
        lines.push(`user_pref("network.proxy.socks_remote_dns", true);`);
      } else {
        lines.push(`user_pref("network.proxy.http", ${JSON.stringify(host)});`);
        lines.push(`user_pref("network.proxy.http_port", ${port});`);
        lines.push(`user_pref("network.proxy.ssl", ${JSON.stringify(host)});`);
        lines.push(`user_pref("network.proxy.ssl_port", ${port});`);
      }
    } catch {
      // Leave direct if malformed
    }
  }
  return `${lines.join("\n")}\n`;
};

/**
 * Format Chromium/Chrome/Brave CLI flags for isolated profile, CDP port, and optional Proxy/Tor routing.
 */
export const buildChromiumLaunchArgs = (options: {
  profileDir: string;
  cdpPort: number;
  headless: boolean;
  networkMode: BrowserNetworkMode;
  proxyUrl: string | null;
  url?: string | undefined;
}): string[] => {
  const args: string[] = [
    `--user-data-dir=${options.profileDir}`,
    `--remote-debugging-port=${options.cdpPort}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-background-networking",
    "--disable-sync",
  ];
  if (options.headless) {
    args.push("--headless=new", "--disable-gpu");
  }
  const effectiveProxy =
    options.networkMode === "tor"
      ? options.proxyUrl || "socks5h://127.0.0.1:9050"
      : options.networkMode === "proxy"
        ? options.proxyUrl
        : null;
  if (effectiveProxy) {
    const normalizedProxy = effectiveProxy.replace(
      /^socks5h:\/\//i,
      "socks5://",
    );
    args.push(`--proxy-server=${normalizedProxy}`);
    if (/^socks/i.test(effectiveProxy) || options.networkMode === "tor") {
      // Force DNS resolution through the SOCKS5 proxy so .onion works and DNS never leaks locally
      args.push("--host-resolver-rules=MAP * ~NOTFOUND , EXCLUDE 127.0.0.1");
    }
  }
  args.push(options.url || "about:blank");
  return args;
};

/**
 * Multi-browser and stealth/proxy/Tor manager for OMR.
 * Bridges:
 * 1. `camofox-browser` (Docker anti-detect Camoufox MCP/REST service on 127.0.0.1:9377)
 * 2. Local browsers (`chromium`, `firefox`, `zen-browser`, `chrome`, `brave`) with loopback CDP
 * 3. Network routing (`direct`, `proxy`, `tor` via `socks5h://127.0.0.1:9050`)
 */
export class BrowserManager {
  readonly context: BrowserContextStore;
  private readonly operations = new ConcurrencyLimiter(1);
  private readonly lifetime = new AbortController();
  private readonly ownedTabs = new Set<string>();
  private contextIssue: string | null = null;
  private closing: Promise<void> | null = null;
  private preferredEngine: BrowserEngineId = "camofox";
  private networkMode: BrowserNetworkMode = "direct";
  private proxyUrl: string | null = null;
  private activeChild: ChildProcess | null = null;
  private activeCleanup: (() => Promise<void>) | null = null;
  private readonly launches = new ConcurrencyLimiter(1);
  private activeLocal: RunningLocalBrowser | null = null;
  private readonly camofoxConfig: CamofoxConfig;

  constructor(
    private readonly sessionDir: string,
    private readonly env: NodeJS.ProcessEnv = process.env,
    private readonly execution?: BrowserExecutionRecorder,
  ) {
    this.context = new BrowserContextStore(sessionDir);
    this.camofoxConfig = resolveCamofoxConfig(env);
    if (env["OMR_BROWSER_PROXY"]) {
      this.proxyUrl = env["OMR_BROWSER_PROXY"]!.trim();
      this.networkMode = "proxy";
    } else if (
      /^(?:1|true|on|yes)$/i.test((env["OMR_BROWSER_TOR"] ?? "").trim())
    ) {
      this.networkMode = "tor";
    }
  }

  /** Whether a tool name belongs to the BrowserManager surface (`camofox_*` or `omr_browser`). */
  ownsTool(name: string): boolean {
    return BROWSER_TOOL_NAMES.includes(name);
  }

  findTool(name: string): ReaTool | undefined {
    return BROWSER_TOOLS.find((t) => t.name === name);
  }

  tools(): readonly ReaTool[] {
    return BROWSER_TOOLS;
  }

  /** Ensure the `camofox-browser` Docker service is reachable, starting the container if stopped. */
  async ensureCamofoxRunning(signal?: AbortSignal): Promise<CamofoxHealth> {
    signal?.throwIfAborted();
    const initial = await probeCamofoxHealth(this.camofoxConfig, signal);
    if (initial.reachable) return initial;
    if (initial.containerState === "stopped") {
      try {
        await new Promise<void>((resolve, reject) => {
          execFile("docker", ["start", "camofox-browser"], { timeout: 5_000, signal }, (error) => error ? reject(error) : resolve());
        });
        const deadline = Date.now() + 4_500;
        while (Date.now() < deadline) {
          await delay(250, undefined, { signal });
          const health = await probeCamofoxHealth(this.camofoxConfig, signal);
          if (health.reachable) return health;
        }
      } catch {
        signal?.throwIfAborted();
        // Fall through and return latest health snapshot
      }
    }
    return probeCamofoxHealth(this.camofoxConfig, signal);
  }

  private camofoxRouting(): CamofoxRouting {
    return {
      supported: false, applied: false, verified: false, managedBy: "server", requestedMode: this.networkMode,
      reason: "Camofox routing is configured by the server; this REST client cannot apply or verify proxy/Tor overrides. Local browser launch preferences are separate.",
    };
  }

  private requireCamofoxRouting(): void {
    if (this.networkMode !== "direct") throw new Error("Camofox routing override unsupported: launch a local browser with proxy/Tor or configure and verify routing on the Camofox server. Clear the local routing preference to use server-managed Camofox routing.");
  }

  async status(signal?: AbortSignal): Promise<BrowserStatusSnapshot> {
    signal?.throwIfAborted();
    const [camofox, tor] = await Promise.all([
      probeCamofoxHealth(this.camofoxConfig, signal),
      abortable(probeTorStatus(this.env), signal),
    ]);
    if (
      this.activeLocal &&
      this.activeChild &&
      this.activeChild.exitCode !== null
    ) {
      this.activeLocal = null;
      this.activeChild = null;
    }
    return {
      preferredEngine: this.preferredEngine,
      networkMode: this.networkMode,
      proxyUrl:
        this.networkMode === "tor"
          ? (this.proxyUrl ?? tor.proxyUrl)
          : this.networkMode === "proxy"
            ? this.proxyUrl
            : null,
      camofox,
      tor,
      installed: discoverInstalledBrowsers(this.env),
      activeLocal: this.activeLocal,
      camofoxRouting: this.camofoxRouting(),
    };
  }

  async setTorMode(enabled: boolean, signal?: AbortSignal): Promise<{
    networkMode: BrowserNetworkMode;
    proxyUrl: string | null;
    tor: TorStatus;
    scope: "local-browser-launch";
    camofoxRouting: CamofoxRouting;
  }> {
    const tor = await abortable(probeTorStatus(this.env), signal);
    signal?.throwIfAborted();
    if (enabled) {
      this.networkMode = "tor";
      this.proxyUrl = tor.proxyUrl;
    } else if (this.networkMode === "tor") {
      this.networkMode = "direct";
      this.proxyUrl = null;
    }
    return { networkMode: this.networkMode, proxyUrl: this.proxyUrl, tor, scope: "local-browser-launch", camofoxRouting: this.camofoxRouting() };
  }

  setProxyMode(proxyUrl: string | null): {
    networkMode: BrowserNetworkMode;
    proxyUrl: string | null;
    scope: "local-browser-launch";
    camofoxRouting: CamofoxRouting;
  } {
    const clean = (proxyUrl ?? "").trim();
    if (!clean || /^(?:off|none|direct|clear|reset)$/i.test(clean)) {
      this.networkMode = "direct";
      this.proxyUrl = null;
    } else if (/^tor$/i.test(clean)) {
      this.networkMode = "tor";
      this.proxyUrl = "socks5h://127.0.0.1:9050";
    } else {
      this.networkMode = "proxy";
      this.proxyUrl = clean;
    }
    return { networkMode: this.networkMode, proxyUrl: this.proxyUrl, scope: "local-browser-launch", camofoxRouting: this.camofoxRouting() };
  }

  setPreferredEngine(engine: BrowserEngineId): void {
    this.preferredEngine = engine;
  }

  /** Launch a real local browser (`chromium`, `firefox`, `zen`, `chrome`, `brave`) with CDP & proxy/Tor. */
  async launchLocalBrowser(
    options: LaunchBrowserOptions = {},
    signal?: AbortSignal,
  ): Promise<RunningLocalBrowser> {
    signal = signal ? AbortSignal.any([signal, this.lifetime.signal]) : this.lifetime.signal;
    return this.launches.run(() => this.launchLocalBrowserAdmitted(options, signal), signal);
  }

  private async launchLocalBrowserAdmitted(options: LaunchBrowserOptions, signal: AbortSignal): Promise<RunningLocalBrowser> {
    signal?.throwIfAborted();
    const installed = discoverInstalledBrowsers(this.env);
    const requestedEngine =
      options.engine ??
      (this.preferredEngine !== "camofox" ? this.preferredEngine : "chromium");
    const targetInfo =
      installed.find((b) => b.id === requestedEngine && b.binary) ??
      installed.find((b) => b.binary !== null);
    if (!targetInfo || !targetInfo.binary) {
      throw new Error(
        `Browser "${requestedEngine}" is not installed. Installed browsers: ${
          installed
            .filter((b) => b.binary)
            .map((b) => `${b.id} (${b.binary})`)
            .join(", ") || "none"
        }`,
      );
    }

    await this.closeLocalBrowser();
    signal?.throwIfAborted();

    const networkMode = options.networkMode ?? this.networkMode;
    let proxyUrl =
      options.proxyUrl !== undefined ? options.proxyUrl : this.proxyUrl;
    if (networkMode === "tor" && !proxyUrl) {
      const tor = await abortable(probeTorStatus(this.env), signal);
      proxyUrl = tor.proxyUrl;
    }
    this.networkMode = networkMode;
    this.proxyUrl = proxyUrl ?? null;
    this.preferredEngine = targetInfo.id;

    const cdpPort = options.cdpPort ?? (await allocateFreePort());
    const headless = options.headless ?? true;
    const profileDir = join(
      this.sessionDir,
      `browser-profile-${targetInfo.id}-${cdpPort}`,
    );
    mkdirSync(profileDir, { recursive: true, mode: 0o700 });

    let args: string[];
    if (targetInfo.family === "chromium") {
      args = buildChromiumLaunchArgs({
        profileDir,
        cdpPort,
        headless,
        networkMode,
        proxyUrl: proxyUrl ?? null,
        url: options.url,
      });
    } else {
      writeFileSync(
        join(profileDir, "user.js"),
        buildFirefoxProfilePrefs(cdpPort, networkMode, proxyUrl ?? null),
        "utf8",
      );
      args = [
        "--no-remote",
        "--profile",
        profileDir,
        "--remote-debugging-port",
        String(cdpPort),
      ];
      if (headless) args.push("--headless");
      args.push(options.url || "about:blank");
    }

    const release = await resources.acquire("browserProcess", signal);
    let child: ChildProcess;
    try { child = spawn(targetInfo.binary, args, {
      stdio: ["ignore", "ignore", "pipe"],
      detached: process.platform !== "win32",
      windowsHide: headless,
      env: { ...this.env },
    }); } catch (error) {release();throw error;}
    this.activeChild = child;
    let cleanup: Promise<void> | null = null;
    const closeOwned = (): Promise<void> => cleanup ??= terminateOwnedProcess(child.pid, process.platform !== "win32", child, 800).finally(release);
    this.activeCleanup = closeOwned;
    child.once("exit", () => {void closeOwned().catch(() => {});});
    let spawnError: Error | null = null;
    child.once("error", (error) => { spawnError = error; void closeOwned().catch(() => {}); });
    // Drain stderr so a verbose child cannot block startup on a full pipe.
    child.stderr?.resume();
    const onAbort = (): void => {
      if (process.platform === "win32") void closeOwned().catch(() => {});
      else signalOwnedProcess(child.pid, true, "SIGTERM");
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      const deadline = Date.now() + 4_000;
      let ready = false;
      while (Date.now() < deadline) {
        signal?.throwIfAborted();
        if (spawnError || child.exitCode !== null || child.signalCode !== null) break;
        if (await abortable(checkTcpPort("127.0.0.1", cdpPort, 250), signal)) { ready = true; break; }
        await delay(150, undefined, { signal });
      }
      signal?.throwIfAborted();
      if (spawnError) throw spawnError;
      if (!ready) throw new Error(`Browser ${targetInfo.id} did not become ready on port ${cdpPort}`);
    } catch (error) {
      await this.closeLocalBrowser();
      throw error;
    } finally {
      signal?.removeEventListener("abort", onAbort);
    }

    this.activeLocal = {
      engine: targetInfo.id,
      binary: targetInfo.binary,
      pid: child.pid ?? 0,
      cdpPort,
      cdpUrl: `http://127.0.0.1:${cdpPort}`,
      profileDir,
      headless,
      networkMode,
      proxyUrl: proxyUrl ?? null,
      startedAt: new Date().toISOString(),
      lastUrl: options.url ?? null,
    };
    await this.recordContext(() => this.context.local(this.activeLocal!.engine, this.activeLocal!.lastUrl ?? "about:blank", this.activeLocal!.cdpUrl));
    return this.activeLocal;
  }

  async closeLocalBrowser(): Promise<boolean> {
    const child = this.activeChild;
    const cleanup = this.activeCleanup; this.activeCleanup = null;
    this.activeChild = null;
    this.activeLocal = null;
    if (!cleanup) return false;
    await this.recordContext(() => this.context.closeLocal());
    await cleanup();
    return Boolean(child);
  }

  private async recordContext(work: () => Promise<void>): Promise<void> {
    try { await work(); this.contextIssue = this.context.warning(); }
    catch (error) { this.contextIssue = error instanceof Error ? error.message : String(error); }
  }
  contextNote(): string | null {
    const note = this.context.note();
    return this.contextIssue && !this.context.warning() ? `${note ?? "[browser context]"}\nContext recording failed: ${this.contextIssue}` : note;
  }

  /** Close only tabs created by this manager. Observed/imported tabs and the shared service survive. */
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.lifetime.abort();
    this.closing = (async () => {
      const deadline = deadlineSignal(5000); const failures: unknown[] = [];
      try {
        await this.operations.run(async () => {
          try { await this.closeLocalBrowser(); } catch (error) { failures.push(error); }
          const { baseUrl, userId, accessKey } = this.camofoxConfig;
          for (const tabId of [...this.ownedTabs]) {
            try {
              deadline.signal.throwIfAborted();
              const work = async () => {
                const response = await fetch(`${baseUrl}/tabs/${encodeURIComponent(tabId)}?${new URLSearchParams({ userId })}`, { method: "DELETE", signal: deadline.signal, headers: accessKey ? { Authorization: `Bearer ${accessKey}` } : {} });
                await response.arrayBuffer();
                if (!response.ok && response.status !== 404) throw new Error(`Owned tab ${tabId} cleanup failed: HTTP ${response.status}`);
                this.ownedTabs.delete(tabId); await this.recordContext(() => this.context.closeTab(tabId));
                return { closed: tabId, cleanup: true };
              };
              if (this.execution) await this.execution.invoke("camofox_close_tab", { tabId, cleanup: true }, false, work, deadline.signal); else await work();
            } catch (error) { failures.push(error); }
          }
        }, deadline.signal);
      } finally { deadline.dispose(); }
      if (failures.length) throw new AggregateError(failures, `Browser cleanup left ${this.ownedTabs.size} owned tab(s) unresolved`);
    })();
    return this.closing;
  }

  /** Execute any `camofox_*` or `omr_browser` tool call and return an REA-compatible result. */
  async call(
    name: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<ReaCallResult> {
    signal = signal ? AbortSignal.any([signal, this.lifetime.signal]) : this.lifetime.signal;
    if (signal.aborted) return this.callUnrecorded(name, args, signal);
    try {
      return await this.operations.run(() => resources.run("browser", async () => {
        if (!this.execution) return this.callUnrecorded(name, args, signal);
        const readOnly = this.findTool(name)?.readOnly === true || (name === "omr_browser" && ["status", "context"].includes(asString(args["action"])));
        return this.execution.invoke(name, args, readOnly, () => this.callUnrecorded(name, args, signal), signal);
      }, signal), signal);
    } catch (error) {
      if (error instanceof UncertainInvocationError) throw error;
      if (!signal.aborted) throw error;
      return { isError: true, text: "Browser operation cancelled before completion", payload: { __error: { code: "CANCELLED", message: String(error) } }, durationMs: 0 };
    }
  }

  private async callUnrecorded(
    name: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<ReaCallResult> {
    const started = performance.now();
    const configuredTimeout = Number(this.env["OMR_BROWSER_TIMEOUT_MS"]);
    const deadline = deadlineSignal(Number.isFinite(configuredTimeout) && configuredTimeout > 0 ? Math.trunc(configuredTimeout) : 30_000, signal);
    try {
      deadline.signal.throwIfAborted();
      await this.context.initialize();
      const tabId = asString(args["tabId"]);
      if (tabId && ["camofox_click", "camofox_type", "camofox_navigate", "camofox_scroll", "camofox_evaluate", "camofox_close_tab"].includes(name)) await this.recordContext(() => this.context.invalidate(tabId));
      if (name === "omr_browser") {
        const payload = await this.handleOmrBrowserTool(args, deadline.signal);
        deadline.signal.throwIfAborted();
        const text = JSON.stringify(payload, null, 2);
        return {
          isError: false,
          text,
          payload,
          durationMs: Math.round(performance.now() - started),
        };
      }
      let payload = await this.callCamofoxTool(name, args, deadline.signal);
      deadline.signal.throwIfAborted();
      if (tabId && ["camofox_click", "camofox_type", "camofox_navigate", "camofox_scroll", "camofox_evaluate"].includes(name)) await this.recordContext(async () => {
        await this.context.observeTab(tabId, typeof args["url"] === "string" ? args["url"] : null);
        await this.context.invalidate(tabId);
      });
      if (this.contextIssue) payload = { ...asRecord(payload), context_persistence_error: this.contextIssue };
      const text =
        typeof payload === "string"
          ? payload
          : JSON.stringify(payload, null, 2);
      return {
        isError: false,
        text,
        payload,
        durationMs: Math.round(performance.now() - started),
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        isError: true,
        text: `browser error (${name}): ${message}`,
        payload: { __error: { code: signal?.aborted ? "CANCELLED" : deadline.signal.aborted ? "TIMEOUT" : "BROWSER_ERROR", message } },
        durationMs: Math.round(performance.now() - started),
      };
    } finally {
      deadline.dispose();
    }
  }

  private async handleOmrBrowserTool(
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>> {
    const action = asString(args["action"]).toLowerCase() || "status";
    const engineArg = asString(args["engine"]).toLowerCase() as
      | BrowserEngineId
      | "";
    const url = asString(args["url"]).trim() || undefined;
    const proxyArg =
      typeof args["proxy"] === "string" ? args["proxy"] : undefined;
    const torArg = typeof args["tor"] === "boolean" ? args["tor"] : undefined;
    const headless =
      typeof args["headless"] === "boolean" ? args["headless"] : true;

    if (action === "context") return { ok: true, context: this.context.read(), note: this.contextNote() };
    if (action === "select") { await this.context.select(asString(args["tabId"])); return { ok: true, context: this.context.read() }; }

    if (torArg !== undefined) {
      await this.setTorMode(torArg, signal);
    } else if (proxyArg !== undefined) {
      this.setProxyMode(proxyArg);
    }

    if (action === "status") {
      return { ok: true, ...(await this.status(signal)) };
    }
    if (action === "tor") {
      const enabled = torArg ?? true;
      const res = await this.setTorMode(enabled, signal);
      return { ok: true, action: "tor", ...res };
    }
    if (action === "proxy") {
      const res = this.setProxyMode(proxyArg ?? null);
      return { ok: true, action: "proxy", ...res };
    }
    if (action === "close") {
      const closedLocal = await this.closeLocalBrowser();
      return { ok: true, action: "close", closedLocal };
    }
    if (action === "launch" || action === "open") {
      const targetEngine: BrowserEngineId = engineArg || this.preferredEngine;
      if (targetEngine === "camofox") {
        this.requireCamofoxRouting();
        this.preferredEngine = "camofox";
        const health = await this.ensureCamofoxRunning(signal);
        if (!health.reachable) {
          throw new Error(
            `camofox-browser is not reachable at ${health.baseUrl} (${health.error ?? "offline"}).`,
          );
        }
        if (url) {
          const tab = await this.callCamofoxTool("camofox_create_tab", { url }, signal);
          return {
            ok: true,
            engine: "camofox",
            camofox: health,
            tab,
            hint: "Use camofox_snapshot(tabId) to inspect the page or camofox_evaluate(tabId, expression) to run JS.",
          };
        }
        return { ok: true, engine: "camofox", camofox: health };
      }
      const running = await this.launchLocalBrowser({
        engine: targetEngine,
        url,
        headless,
      }, signal);
      return {
        ok: true,
        engine: running.engine,
        browser: running,
        rea_cdp_hint: `Pass cdp_endpoint="${running.cdpUrl}" to REA's list_browser_targets, then target_id to inspect_web_page / observe_web_session. A TCP listener alone does not verify CDP support.`,
      };
    }
    throw new Error(`Unsupported omr_browser action "${action}".`);
  }

  private async callCamofoxTool(
    name: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<unknown> {
    signal?.throwIfAborted();
    this.requireCamofoxRouting();
    const health = await this.ensureCamofoxRunning(signal);
    signal?.throwIfAborted();
    if (!health.reachable) {
      throw new Error(
        `camofox-browser service at ${this.camofoxConfig.baseUrl} is unreachable (${health.error ?? "offline"}). Ensure the camofox-browser Docker container is running.`,
      );
    }

    const { baseUrl, userId, sessionKey, accessKey, apiKey, cookiesDir } =
      this.camofoxConfig;
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (accessKey) headers["Authorization"] = `Bearer ${accessKey}`;

    const fetchJson = async (
      method: string,
      path: string,
      body?: Record<string, unknown>,
      customHeaders?: Record<string, string>,
    ): Promise<unknown> => {
      const res = await fetch(`${baseUrl}${path}`, {
        method,
        headers: customHeaders ?? headers,
        ...(body ? { body: JSON.stringify(body) } : {}),
        ...(signal ? { signal } : {}),
      });
      if (!res.ok) {
        const errText = await res.text();
        throw new Error(`HTTP ${res.status}: ${errText}`);
      }
      return res.json();
    };

    const saveScreenshotDisk = (
      tabId: string,
      base64Data: string,
    ): string | null => {
      try {
        const dir = join(this.sessionDir, "screenshots");
        mkdirSync(dir, { recursive: true, mode: 0o700 });
        const safeTab =
          tabId.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 32) || "tab";
        const filePath = join(dir, `camofox-${safeTab}-${randomUUID()}.png`);
        writeFileSync(filePath, Buffer.from(base64Data, "base64"), { flag: "wx", mode: 0o600 });
        return filePath;
      } catch {
        return null;
      }
    };

    switch (name) {
      case "camofox_create_tab": {
        const url = asString(args["url"]).trim();
        if (!url) throw new Error("camofox_create_tab requires url");
        const result = await fetchJson("POST", "/tabs", { url, userId, sessionKey });
        const data = asRecord(result); const tab = asRecord(data?.["tab"]) ?? data;
        const tabId = asString(tab?.["tabId"]) || asString(tab?.["id"]);
        if (tabId) { this.ownedTabs.add(tabId); const endpoint=new URL(baseUrl);endpoint.username="";endpoint.password="";endpoint.search="";endpoint.hash="";await this.recordContext(() => this.context.observeTab(tabId, asString(tab?.["url"]) || url, true, true, {runId:this.context.runId,baseUrl:endpoint.toString().replace(/\/$/,""),userId,sessionKey})); }
        else this.contextIssue = "Create-tab response did not identify the created tab; ownership and cleanup could not be recorded";
        return result;
      }
      case "camofox_snapshot": {
        const tabId = asString(args["tabId"]).trim();
        if (!tabId) throw new Error("camofox_snapshot requires tabId");
        const params = new URLSearchParams({
          userId,
          includeScreenshot: "true",
        });
        if (typeof args["offset"] === "number")
          params.set("offset", String(args["offset"]));
        const raw = asRecord(
          await fetchJson(
            "GET",
            `/tabs/${encodeURIComponent(tabId)}/snapshot?${params}`,
          ),
        );
        if (!raw) return raw;
        const screenshot = asRecord(raw["screenshot"]);
        const rest: Record<string, unknown> = { ...raw };
        delete rest["screenshot"];
        delete rest["saved_screenshot_path"];
        const b64 = asString(screenshot?.["data"]);
        if (b64) {
          const savedPath = saveScreenshotDisk(tabId, b64);
          if (savedPath) rest["saved_screenshot_path"] = savedPath;
        }
        await this.recordContext(() => this.context.capture(tabId, rest));
        return rest;
      }
      case "camofox_click": {
        const tabId = asString(args["tabId"]).trim();
        if (!tabId) throw new Error("camofox_click requires tabId");
        const { tabId: _omit, ...rest } = args;
        return fetchJson("POST", `/tabs/${encodeURIComponent(tabId)}/click`, {
          ...rest,
          userId,
        });
      }
      case "camofox_type": {
        const tabId = asString(args["tabId"]).trim();
        if (!tabId) throw new Error("camofox_type requires tabId");
        const { tabId: _omit, ...rest } = args;
        return fetchJson("POST", `/tabs/${encodeURIComponent(tabId)}/type`, {
          ...rest,
          userId,
        });
      }
      case "camofox_navigate": {
        const tabId = asString(args["tabId"]).trim();
        if (!tabId) throw new Error("camofox_navigate requires tabId");
        const { tabId: _omit, ...rest } = args;
        return fetchJson(
          "POST",
          `/tabs/${encodeURIComponent(tabId)}/navigate`,
          { ...rest, userId },
        );
      }
      case "camofox_scroll": {
        const tabId = asString(args["tabId"]).trim();
        if (!tabId) throw new Error("camofox_scroll requires tabId");
        const { tabId: _omit, ...rest } = args;
        return fetchJson("POST", `/tabs/${encodeURIComponent(tabId)}/scroll`, {
          ...rest,
          userId,
        });
      }
      case "camofox_screenshot": {
        const tabId = asString(args["tabId"]).trim();
        if (!tabId) throw new Error("camofox_screenshot requires tabId");
        const res = await fetch(
          `${baseUrl}/tabs/${encodeURIComponent(tabId)}/screenshot?${new URLSearchParams({ userId })}`,
          {
            method: "GET",
            headers,
            ...(signal ? { signal } : {}),
          },
        );
        if (!res.ok) {
          throw new Error(`HTTP ${res.status}: ${await res.text()}`);
        }
        const contentType = res.headers.get("content-type") || "";
        if (!contentType.startsWith("image/")) {
          throw new Error(`Screenshot failed: ${await res.text()}`);
        }
        const buf = Buffer.from(await res.arrayBuffer());
        const savedPath = saveScreenshotDisk(tabId, buf.toString("base64"));
        if (savedPath) await this.recordContext(() => this.context.screenshot(tabId, savedPath));
        return {
          ok: true,
          tabId,
          mimeType: contentType,
          bytes: buf.byteLength,
          saved_screenshot_path: savedPath,
        };
      }
      case "camofox_close_tab": {
        const tabId = asString(args["tabId"]).trim();
        if (!tabId) throw new Error("camofox_close_tab requires tabId");
        const result = await fetchJson(
          "DELETE",
          `/tabs/${encodeURIComponent(tabId)}?${new URLSearchParams({ userId })}`,
        );
        this.ownedTabs.delete(tabId); await this.recordContext(() => this.context.closeTab(tabId));
        return result;
      }
      case "camofox_evaluate": {
        const tabId = asString(args["tabId"]).trim();
        const expression = asString(args["expression"]);
        if (!tabId || !expression)
          throw new Error("camofox_evaluate requires tabId and expression");
        return fetchJson(
          "POST",
          `/tabs/${encodeURIComponent(tabId)}/evaluate`,
          { userId, expression },
        );
      }
      case "camofox_list_tabs": {
        const result = await fetchJson("GET", `/tabs?${new URLSearchParams({ userId })}`);
        const tabs = Array.isArray(result) ? result : asRecord(result)?.["tabs"];
        if (Array.isArray(tabs)) for (const raw of tabs) {
          const tab = asRecord(raw); const id = asString(tab?.["tabId"]) || asString(tab?.["id"]);
          if (id) await this.recordContext(() => this.context.observeTab(id, typeof tab?.["url"] === "string" ? tab["url"] : null, false, false));
        }
        return result;
      }
      case "camofox_import_cookies": {
        if (!apiKey) {
          throw new Error(
            "CAMOFOX_API_KEY is not set; cookie import requires CAMOFOX_API_KEY.",
          );
        }
        const rawCookiePath = asString(args["cookiesPath"]).trim();
        if (!rawCookiePath)
          throw new Error("camofox_import_cookies requires cookiesPath");
        const candidatePath = existsSync(rawCookiePath)
          ? resolve(rawCookiePath)
          : resolve(cookiesDir, rawCookiePath);
        if (!existsSync(candidatePath)) {
          throw new Error(`Cookie file not found: ${candidatePath}`);
        }
        const domainSuffix = asString(args["domainSuffix"]).trim() || undefined;
        const cookies = parseNetscapeCookies(
          readFileSync(candidatePath, "utf8"),
          domainSuffix,
        );
        const result = await fetchJson(
          "POST",
          `/sessions/${encodeURIComponent(userId)}/cookies`,
          { cookies },
          {
            "Content-Type": "application/json",
            Authorization: `Bearer ${apiKey}`,
          },
        );
        return { imported: cookies.length, userId, result };
      }
      default:
        throw new Error(`Unknown camofox tool: ${name}`);
    }
  }
}

export const renderBrowserStatus = (snap: BrowserStatusSnapshot): string => {
  const camoStatus = snap.camofox.reachable
    ? `● online (${snap.camofox.baseUrl} · engine=${snap.camofox.engine ?? "camoufox"} · tabs=${snap.camofox.activeTabs} · docker=${snap.camofox.containerState})`
    : `○ offline (${snap.camofox.baseUrl} · docker=${snap.camofox.containerState}${snap.camofox.error ? ` · ${snap.camofox.error}` : ""})`;
  const torLine = snap.tor.available
    ? `● reachable (${snap.tor.proxyUrl} · ${snap.tor.source})`
    : `◌ standby (${snap.tor.proxyUrl} · ${snap.tor.source})`;
  const routingLine =
    snap.networkMode === "tor"
      ? `tor (${snap.proxyUrl ?? snap.tor.proxyUrl} · remote DNS / .onion enabled)`
      : snap.networkMode === "proxy"
        ? `proxy (${snap.proxyUrl ?? "unconfigured"})`
        : "direct (no proxy)";

  const lines: string[] = [
    `preferred  ${snap.preferredEngine} (anti-bot/CAPTCHA default: camofox)`,
    `routing    ${routingLine} (preference for the next local browser launch)`,
    `camofox routing: server-managed, unverified; proxy/Tor override unsupported by this client`,
    `camofox    ${camoStatus}`,
    `tor        ${torLine}`,
    `local      ${
      snap.activeLocal
        ? `● ${snap.activeLocal.engine} running (pid ${snap.activeLocal.pid} · CDP ${snap.activeLocal.cdpUrl} · ${snap.activeLocal.headless ? "headless" : "gui"} · ${snap.activeLocal.networkMode})`
        : "none launched (use `/browser chromium|firefox|zen [url]` to start with CDP)"
    }`,
    `installed:`,
  ];
  for (const b of snap.installed) {
    const icon = b.binary ? "●" : "○";
    lines.push(
      `  ${icon} ${b.id.padEnd(10)} ${b.name.padEnd(18)} ${b.binary ?? "(not installed)"}`,
    );
  }
  return lines.join("\n");
};
