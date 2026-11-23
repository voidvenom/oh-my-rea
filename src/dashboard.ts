import { createServer, type Server, type ServerResponse } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import {
  JournalTailer,
  readFileTail,
  type JournalCheckpointEntry,
  type JournalToolEntry,
  type JournalUnknownHead,
} from "./journal.js";
import type { SessionInfo } from "./session.js";
import type { SubagentGraphSnapshot } from "./subagent.js";
import type { InvestigationSnapshot } from "./investigation.js";

export type DashboardTool = JournalToolEntry;

export interface DashboardSnapshot {
  session: { id: string; dir: string; target: string | null };
  phase: "unstarted" | "running" | "ended";
  outcome: string | null;
  started_at: string | null;
  ended_at: string | null;
  elapsed_ms: number | null;
  counts: {
    records: number;
    tool_calls: number;
    tool_failures: number;
    evidence: number;
    unknowns: number;
    checkpoints: number;
  };
  tools: DashboardTool[];
  evidence_ids: string[];
  unknowns: JournalUnknownHead[];
  checkpoints: JournalCheckpointEntry[];
  subagents: SubagentGraphSnapshot | null;
  report: string;
  journal_bytes: number;
  counts_source: "journal-observations";
  investigation: InvestigationSnapshot | null;
}

const REPORT_TAIL_LIMIT = 65_536;

const readSubagentsFile = async (
  sessionDir: string,
): Promise<SubagentGraphSnapshot | null> => {
  try {
    const raw = await readFile(join(sessionDir, "subagents.json"), "utf8");
    return JSON.parse(raw) as SubagentGraphSnapshot;
  } catch {
    return null;
  }
};

export const readSnapshot = async (
  session: SessionInfo,
  omrTarget: string | null,
  tailer = new JournalTailer(session.journalPath),
  investigation: (() => InvestigationSnapshot) | undefined = undefined,
): Promise<DashboardSnapshot> => {
  const [state, report, subagents] = await Promise.all([
    tailer.sync(),
    readFileTail(session.reportPath, REPORT_TAIL_LIMIT),
    readSubagentsFile(session.dir),
  ]);
  return {
    session: { id: session.id, dir: session.dir, target: omrTarget },
    phase: state.phase,
    outcome: state.outcome,
    started_at: state.started_at,
    ended_at: state.ended_at,
    elapsed_ms: state.elapsed_ms,
    counts: {
      records: state.counts.records,
      tool_calls: state.counts.tool_calls,
      tool_failures: state.counts.tool_failures,
      evidence: state.counts.evidence,
      unknowns: state.counts.unknowns,
      checkpoints: state.counts.checkpoints,
    },
    tools: state.tools,
    evidence_ids: state.evidence_ids,
    unknowns: state.unknowns,
    checkpoints: state.checkpoints,
    subagents,
    report,
    journal_bytes: state.journal_bytes,
    counts_source: "journal-observations",
    investigation: investigation?.() ?? null,
  };
};

const HTML = String.raw`<!doctype html>
<html lang="en">
<meta charset="utf-8">
<title>omr session</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  :root { --bg:#0e1116; --panel:#161b22; --line:#26303b; --fg:#e6edf3; --muted:#8b98a5; --ok:#3fb950; --bad:#f85149; --accent:#58a6ff; --warn:#d29922; }
  @media (prefers-color-scheme: light) { :root { --bg:#f6f8fa; --panel:#ffffff; --line:#d0d7de; --fg:#1f2328; --muted:#59636e; --ok:#1a7f37; --bad:#cf222e; --accent:#0969da; --warn:#9a6700; } }
  * { box-sizing:border-box; }
  body { margin:0; padding:20px; background:var(--bg); color:var(--fg); font:14px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace; }
  h1 { font-size:16px; margin:0 0 4px; }
  .muted { color:var(--muted); }
  .grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(140px,1fr)); gap:10px; margin:16px 0; }
  .card { background:var(--panel); border:1px solid var(--line); border-radius:8px; padding:10px 12px; }
  .card b { display:block; font-size:20px; }
  .panel { background:var(--panel); border:1px solid var(--line); border-radius:8px; margin:12px 0; overflow:hidden; }
  .panel h2 { font-size:12px; letter-spacing:.08em; text-transform:uppercase; color:var(--muted); margin:0; padding:10px 12px; border-bottom:1px solid var(--line); }
  table { width:100%; border-collapse:collapse; }
  td,th { text-align:left; padding:6px 12px; border-bottom:1px solid var(--line); font-size:12.5px; vertical-align:top; }
  th { color:var(--muted); font-weight:500; }
  tr:last-child td { border-bottom:0; }
  .ok { color:var(--ok); } .bad { color:var(--bad); } .acc { color:var(--accent); } .warn { color:var(--warn); }
  pre { margin:0; padding:12px; white-space:pre-wrap; word-break:break-word; max-height:420px; overflow:auto; font-size:12.5px; }
  .pill { border:1px solid var(--line); border-radius:999px; padding:1px 8px; margin:2px; display:inline-block; font-size:11.5px; }
  .row { display:flex; gap:16px; flex-wrap:wrap; }
  .row > .panel { flex:1 1 420px; }
  .mesh-grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(320px,1fr)); gap:12px; padding:12px; }
  .mesh-node { border:1px solid var(--line); border-radius:8px; padding:10px 12px; background:rgba(88,166,255,0.03); }
  .mesh-head { display:flex; justify-content:space-between; align-items:center; gap:8px; margin-bottom:6px; font-weight:600; }
  .mesh-steps { margin-top:8px; border-top:1px solid var(--line); padding-top:6px; font-size:12px; }
  .mesh-step { padding:3px 0; border-bottom:1px dashed var(--line); }
  .mesh-step:last-child { border-bottom:0; }
</style>
<body>
<h1 id="title">omr session</h1>
<div class="muted" id="sub"></div>
<div class="grid" id="stats"></div>
<div class="panel"><h2>Subagent Mesh &amp; Live Step DAG</h2><div id="subagents" class="mesh-grid"><span class="muted">no subagents spawned</span></div></div>
<div class="row">
  <div class="panel"><h2>Tool timeline</h2><table><thead><tr><th>seq</th><th>tool</th><th>result</th><th>evidence</th></tr></thead><tbody id="tools"></tbody></table></div>
  <div class="panel"><h2>Residual unknowns</h2><table><thead><tr><th>status</th><th>severity</th><th>domain</th><th>id</th></tr></thead><tbody id="unknowns"></tbody></table></div>
</div>
<div class="row">
  <div class="panel"><h2>Evidence</h2><div id="evidence" style="padding:10px 12px"></div></div>
  <div class="panel"><h2>Checkpoints</h2><table><thead><tr><th>through</th><th>records</th><th>unknowns</th><th>bytes</th></tr></thead><tbody id="checkpoints"></tbody></table></div>
</div>
<div class="panel"><h2>Report</h2><pre id="report"></pre></div>
<p class="muted" id="footer"></p>
<script>
const $ = (id) => document.getElementById(id);
const cell = (text, cls) => { const td = document.createElement('td'); td.textContent = text; if (cls) td.className = cls; return td; };
const row = (values) => { const tr = document.createElement('tr'); for (const v of values) tr.appendChild(v); return tr; };
const dur = (ms) => ms == null ? '' : ms < 1000 ? ms + 'ms' : (ms/1000).toFixed(1) + 's';
async function refresh() {
  let s;
  try { s = await (await fetch('/api/state', { cache: 'no-store' })).json(); }
  catch { $('footer').textContent = 'dashboard disconnected'; return; }
  $('title').textContent = 'omr · ' + (s.session.target || 'no target');
  $('sub').textContent = s.session.id + ' · ' + s.phase + (s.outcome ? ' · ' + s.outcome : '') + ' · ' + s.session.dir;
  const subCount = s.subagents && s.subagents.nodes ? s.subagents.nodes.length : 0;
  const stats = [
    ['tools', s.counts.tool_calls], ['failures', s.counts.tool_failures],
    ['retained evidence', s.investigation?.ledger.evidence ?? '?'], ['non-resolved unknowns', s.investigation?.ledger.unknownOpen ?? '?'],
    ['ledger source', s.investigation?.ledger.health ?? 'not connected'], ['journal evidence IDs', s.counts.evidence],
    ['subagents', subCount], ['checkpoints', s.counts.checkpoints],
    ['journal', s.counts.records], ['bytes', s.journal_bytes],
  ];
  $('stats').replaceChildren(...stats.map(([k,v]) => {
    const div = document.createElement('div'); div.className = 'card';
    const b = document.createElement('b'); b.textContent = v;
    const span = document.createElement('span'); span.className = 'muted'; span.textContent = k;
    div.append(b, span); return div;
  }));
  const nodes = s.subagents && Array.isArray(s.subagents.nodes) ? s.subagents.nodes : [];
  if (!nodes.length) {
    $('subagents').replaceChildren(Object.assign(document.createElement('span'), { className: 'muted', textContent: 'no subagents spawned yet' }));
  } else {
    $('subagents').replaceChildren(...nodes.map(n => {
      const box = document.createElement('div'); box.className = 'mesh-node';
      const head = document.createElement('div'); head.className = 'mesh-head';
      const title = document.createElement('span');
      title.textContent = n.id + ' [' + n.role + ']' + (n.workflow ? ' {' + n.workflow + '}' : '');
      const badge = document.createElement('span');
      badge.className = 'pill ' + (n.status === 'completed' ? 'ok' : n.status === 'running' ? 'acc' : n.status === 'queued' ? 'warn' : 'bad');
      badge.textContent = n.status + ' · step ' + n.currentStep + '/' + (n.maxSteps > 0 ? n.maxSteps : '∞') + (n.durationMs != null ? ' · ' + dur(n.durationMs) : '');
      head.append(title, badge);
      const goal = document.createElement('div'); goal.className = 'muted'; goal.textContent = n.goal;
      box.append(head, goal);
      if (n.dependsOn && n.dependsOn.length) {
        const dep = document.createElement('div'); dep.className = 'acc'; dep.style.fontSize = '12px';
        dep.textContent = 'depends_on: ' + n.dependsOn.join(', ');
        box.append(dep);
      }
      if (n.steers && n.steers.length) {
        for (const st of n.steers) {
          const stDiv = document.createElement('div'); stDiv.className = 'warn'; stDiv.style.fontSize = '12px';
          stDiv.textContent = '⚡ steer (' + st.mode + ', step ' + st.appliedAtStep + '): ' + st.prompt;
          box.append(stDiv);
        }
      }
      const stepsBox = document.createElement('div'); stepsBox.className = 'mesh-steps';
      const steps = Array.isArray(n.stepsLog) ? n.stepsLog : [];
      if (!steps.length) {
        const empty = document.createElement('div'); empty.className = 'muted'; empty.textContent = 'waiting for first step…';
        stepsBox.append(empty);
      } else {
        for (const st of steps) {
          const rowDiv = document.createElement('div'); rowDiv.className = 'mesh-step';
          const toolsText = (st.tools || []).map(tc => tc.displayTool + '(' + (tc.status === 'running' ? '…' : tc.status) + ')').join(' → ');
          rowDiv.textContent = '#' + st.step + ' [' + st.phase + '] ' + (toolsText || st.textPreview || st.reasoningPreview || '');
          stepsBox.append(rowDiv);
        }
      }
      box.append(stepsBox);
      return box;
    }));
  }
  $('tools').replaceChildren(...s.tools.slice().reverse().map(t => row([
    cell(String(t.seq), 'muted'), cell(t.tool), cell(t.ok === null ? '…' : t.ok ? 'ok ' + dur(t.duration_ms) : 'fail' + (t.error_code ? ' ' + t.error_code : ''), t.ok === false ? 'bad' : 'ok'),
    cell(t.evidence_ids.map(id => id.slice(0, 12)).join(', '), 'acc'),
  ])));
  $('unknowns').replaceChildren(...s.unknowns.map(u => row([
    cell(u.status), cell(u.severity), cell(u.domain), cell(u.unknown_id.slice(0, 18), 'muted'),
  ])));
  $('evidence').replaceChildren(...(s.evidence_ids.length ? s.evidence_ids.map(id => {
    const span = document.createElement('span'); span.className = 'pill acc'; span.textContent = id.slice(0, 16); return span;
  }) : [Object.assign(document.createElement('span'), { className: 'muted', textContent: 'no evidence yet' })]));
  $('checkpoints').replaceChildren(...s.checkpoints.slice().reverse().map(c => row([
    cell(String(c.through_seq ?? '')), cell(String(c.records ?? '')), cell(String(c.unknowns ?? '')), cell(String(c.bytes ?? '')),
  ])));
  $('report').textContent = s.report || '(no report yet)';
  $('footer').textContent = 'updated ' + new Date().toLocaleTimeString();
}
refresh(); setInterval(refresh, 1500);
</script>
</body>
</html>`;

export class Dashboard {
  private server: Server | null = null;
  private url: string | null = null;
  private readonly tailer: JournalTailer;
  private cachedReport = "";
  private cachedReportSize = -1;
  private cachedReportMtime = -1;

  constructor(
    private readonly session: SessionInfo,
    private readonly target: () => string | null,
    tailer?: JournalTailer,
    private readonly investigation?: (() => InvestigationSnapshot) | undefined,
  ) {
    this.tailer = tailer ?? new JournalTailer(session.journalPath);
  }

  get address(): string | null {
    return this.url;
  }

  private async readReportCached(): Promise<string> {
    let info;
    try {
      info = await stat(this.session.reportPath);
    } catch {
      this.cachedReport = "";
      this.cachedReportSize = 0;
      this.cachedReportMtime = 0;
      return "";
    }
    if (
      info.size === this.cachedReportSize &&
      info.mtimeMs === this.cachedReportMtime
    ) {
      return this.cachedReport;
    }
    const text = await readFileTail(this.session.reportPath, REPORT_TAIL_LIMIT);
    this.cachedReport = text;
    this.cachedReportSize = info.size;
    this.cachedReportMtime = info.mtimeMs;
    return text;
  }

  async start(
    port = Number(process.env["OMR_DASHBOARD_PORT"] ?? 0),
  ): Promise<string> {
    if (this.server && this.url) return this.url;
    const server = createServer((request, response) => {
      void this.route(request.url ?? "/", response);
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(Number.isFinite(port) ? port : 0, "127.0.0.1", () =>
        resolve(),
      );
    });
    this.server = server;
    const address = server.address();
    const actualPort =
      typeof address === "object" && address !== null ? address.port : 0;
    this.url = `http://127.0.0.1:${actualPort}/`;
    return this.url;
  }

  private async route(url: string, response: ServerResponse): Promise<void> {
    if (url === "/" || url === "/index.html") {
      response.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
      });
      response.end(HTML);
      return;
    }
    if (url === "/api/state") {
      try {
        const [state, report, subagents] = await Promise.all([
          this.tailer.sync(),
          this.readReportCached(),
          readSubagentsFile(this.session.dir),
        ]);
        const snapshot: DashboardSnapshot = {
          session: {
            id: this.session.id,
            dir: this.session.dir,
            target: this.target(),
          },
          phase: state.phase,
          outcome: state.outcome,
          started_at: state.started_at,
          ended_at: state.ended_at,
          elapsed_ms: state.elapsed_ms,
          counts: {
            records: state.counts.records,
            tool_calls: state.counts.tool_calls,
            tool_failures: state.counts.tool_failures,
            evidence: state.counts.evidence,
            unknowns: state.counts.unknowns,
            checkpoints: state.counts.checkpoints,
          },
          tools: state.tools,
          evidence_ids: state.evidence_ids,
          unknowns: state.unknowns,
          checkpoints: state.checkpoints,
          subagents,
          report,
          journal_bytes: state.journal_bytes,
          counts_source: "journal-observations",
          investigation: this.investigation?.() ?? null,
        };
        response.writeHead(200, {
          "content-type": "application/json; charset=utf-8",
          "cache-control": "no-store",
        });
        response.end(JSON.stringify(snapshot));
      } catch (error) {
        response.writeHead(500, {
          "content-type": "application/json; charset=utf-8",
        });
        response.end(
          JSON.stringify({
            error: error instanceof Error ? error.message : String(error),
          }),
        );
      }
      return;
    }
    response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    response.end("not found");
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = null;
    this.url = null;
    if (!server) return;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}
