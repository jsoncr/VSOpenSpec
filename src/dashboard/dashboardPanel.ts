// Panel webview del dashboard: stats y gráficos de cambios y tareas.
import * as vscode from "vscode";
import { Analytics, Section, ChangeRow } from "./analytics";

/** Nonce para la CSP del webview. */
function makeNonce(): string {
  let text = "";
  const chars =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  for (let i = 0; i < 32; i++) {
    text += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return text;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Formatea ms epoch a fecha local corta; "—" si no hay dato. */
function fmtDate(ms?: number): string {
  if (ms === undefined) return "—";
  return new Date(ms).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

export class DashboardPanel {
  private static current: DashboardPanel | undefined;
  private readonly panel: vscode.WebviewPanel;
  private disposables: vscode.Disposable[] = [];

  private constructor(private readonly getAnalytics: () => Analytics) {
    this.panel = vscode.window.createWebviewPanel(
      "openspecDashboard",
      vscode.l10n.t("OpenSpec Dashboard"),
      vscode.ViewColumn.Active,
      { enableScripts: true, retainContextWhenHidden: true }
    );
    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
    this.panel.webview.onDidReceiveMessage(
      (msg) => {
        if (msg?.type === "refresh") {
          this.update();
        }
      },
      null,
      this.disposables
    );
    this.update();
  }

  static show(getAnalytics: () => Analytics): void {
    if (!DashboardPanel.current) {
      DashboardPanel.current = new DashboardPanel(getAnalytics);
    } else {
      DashboardPanel.current.update();
    }
    DashboardPanel.current.panel.reveal(vscode.ViewColumn.Active);
  }

  /** Re-renderiza si el dashboard está abierto (tras cambios en disco). */
  static refreshCurrent(): void {
    DashboardPanel.current?.update();
  }

  private update(): void {
    this.panel.webview.html = this.render(this.getAnalytics());
  }

  private render(a: Analytics): string {
    const nonce = makeNonce();
    const csp = `default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';`;
    const t = vscode.l10n.t.bind(vscode.l10n);

    const generated = t("Generated: {0}", new Date(a.generatedAt).toLocaleString());

    return `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="${csp}" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<style>${STYLES}</style>
</head>
<body>
  <header class="top">
    <h1>${t("OpenSpec Dashboard")}</h1>
    <div class="top-right">
      <span class="muted">${escapeHtml(generated)}</span>
      <button id="refresh" class="btn">${t("Refresh")}</button>
    </div>
  </header>

  <nav class="tabs">
    <button class="tab active" data-target="panel-active">${t("Active")} <span class="count">${a.active.changeCount}</span></button>
    <button class="tab" data-target="panel-archived">${t("Archived")} <span class="count">${a.archived.changeCount}</span></button>
  </nav>

  <section id="panel-active" class="panel active">
    ${this.renderSection(a.active, false, t)}
  </section>
  <section id="panel-archived" class="panel">
    ${this.renderSection(a.archived, true, t)}
  </section>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    document.querySelectorAll('.tab').forEach((tab) => {
      tab.addEventListener('click', () => {
        document.querySelectorAll('.tab').forEach((x) => x.classList.remove('active'));
        document.querySelectorAll('.panel').forEach((x) => x.classList.remove('active'));
        tab.classList.add('active');
        document.getElementById(tab.dataset.target).classList.add('active');
      });
    });
    document.getElementById('refresh').addEventListener('click', () => {
      vscode.postMessage({ type: 'refresh' });
    });
  </script>
</body>
</html>`;
  }

  private renderSection(
    s: Section,
    archived: boolean,
    t: typeof vscode.l10n.t
  ): string {
    if (s.changeCount === 0) {
      return `<p class="empty">${t("No changes to show here.")}</p>`;
    }

    const kpis = archived
      ? [
          kpi(t("Archived changes"), String(s.changeCount)),
          kpi(
            t("Archived complete"),
            `${s.completedChanges}/${s.changeCount}`,
            pctStr(s.completedChanges, s.changeCount)
          ),
          kpi(t("Total tasks"), String(s.totalTasks)),
          kpi(
            t("Avg. duration"),
            s.avgDurationDays !== undefined
              ? t("{0} days", s.avgDurationDays)
              : "—"
          ),
        ]
      : [
          kpi(t("Active changes"), String(s.changeCount)),
          kpi(t("Global completion"), `${s.pctComplete}%`),
          kpi(t("Completed tasks"), `${s.doneTasks}/${s.totalTasks}`),
          kpi(t("Pending tasks"), String(s.pendingTasks)),
        ];

    const timeField: keyof ChangeRow = archived ? "archivedAt" : "createdAt";
    const timeTitle = archived
      ? t("Changes by archive month")
      : t("Changes by creation month");

    // El mapa de progreso y la velocidad solo aportan en la vista de activos.
    const progressMap = archived
      ? ""
      : `<div class="card">
          <h3>${t("Progress map")}</h3>
          ${progressMapView(s.rows)}
        </div>`;
    // Mind map colapsable (nodos conectados) debajo del mapa lineal.
    const mindMap = archived
      ? ""
      : `<details class="card mindmap-card" open>
          <summary><h3>${t("Mind map")}</h3></summary>
          ${mindMapView(s, t)}
        </details>`;
    const velocityCard =
      archived || s.velocity.length === 0
        ? ""
        : `<div class="card">
            <h3>${t("Velocity (tasks completed per week)")}</h3>
            ${velocityChart(s.velocity, t)}
          </div>`;

    return `
      <div class="kpis">${kpis.join("")}</div>

      ${progressMap}

      ${mindMap}

      <div class="grid-2">
        <div class="card">
          <h3>${t("Task completion")}</h3>
          ${donut(s.doneTasks, s.totalTasks, t)}
        </div>
        <div class="card">
          <h3>${t("Progress distribution")}</h3>
          ${histogram(s.progressBuckets, t)}
        </div>
      </div>

      ${velocityCard}

      <div class="card">
        <h3>${t("Progress by change")}</h3>
        ${barList(s.rows, archived, t)}
      </div>

      <div class="card">
        <h3>${escapeHtml(timeTitle)}</h3>
        ${monthChart(s.byMonth, t)}
      </div>

      <div class="card">
        <h3>${t("Timeline detail")}</h3>
        ${detailTable(s.rows, archived, timeField, t)}
      </div>
    `;
  }

  private dispose(): void {
    DashboardPanel.current = undefined;
    this.panel.dispose();
    while (this.disposables.length) {
      this.disposables.pop()?.dispose();
    }
  }
}

// ---------- Helpers de gráficos (SVG/CSS puro) ----------

function pctStr(done: number, total: number): string {
  const p = total > 0 ? Math.round((done / total) * 100) : 0;
  return `${p}%`;
}

function kpi(label: string, value: string, sub?: string): string {
  return `<div class="kpi">
    <div class="kpi-value">${escapeHtml(value)}</div>
    <div class="kpi-label">${escapeHtml(label)}</div>
    ${sub ? `<div class="kpi-sub">${escapeHtml(sub)}</div>` : ""}
  </div>`;
}

/** Donut de completitud (hecho vs pendiente). */
function donut(done: number, total: number, t: typeof vscode.l10n.t): string {
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;
  const r = 54;
  const c = 2 * Math.PI * r;
  const frac = total > 0 ? done / total : 0;
  const dash = `${(c * frac).toFixed(2)} ${(c * (1 - frac)).toFixed(2)}`;
  return `
    <div class="donut-wrap">
      <svg viewBox="0 0 140 140" width="150" height="150" role="img" aria-label="${pct}%">
        <circle cx="70" cy="70" r="${r}" fill="none" stroke="var(--track)" stroke-width="16"/>
        <circle cx="70" cy="70" r="${r}" fill="none" stroke="var(--c-green)" stroke-width="16"
          stroke-dasharray="${dash}" stroke-dashoffset="0" transform="rotate(-90 70 70)" stroke-linecap="round"/>
        <text x="70" y="66" text-anchor="middle" class="donut-pct">${pct}%</text>
        <text x="70" y="86" text-anchor="middle" class="donut-sub">${done}/${total}</text>
      </svg>
      <div class="legend">
        <span><i class="dot" style="background:var(--c-green)"></i>${t("Done")} (${done})</span>
        <span><i class="dot" style="background:var(--track)"></i>${t("Pending")} (${total - done})</span>
      </div>
    </div>`;
}

/** Histograma de distribución de progreso (6 buckets). */
function histogram(buckets: number[], t: typeof vscode.l10n.t): string {
  const labels = ["0%", "1–25%", "26–50%", "51–75%", "76–99%", "100%"];
  const max = Math.max(1, ...buckets);
  const bars = buckets
    .map((v, i) => {
      const h = Math.round((v / max) * 100);
      return `<div class="hbar">
        <div class="hbar-track"><div class="hbar-fill" style="height:${h}%"></div><span class="hbar-val">${v}</span></div>
        <div class="hbar-label">${labels[i]}</div>
      </div>`;
    })
    .join("");
  return `<div class="hist">${bars}</div>`;
}

/** Barras horizontales de progreso por cambio. */
function barList(
  rows: ChangeRow[],
  archived: boolean,
  t: typeof vscode.l10n.t
): string {
  const items = rows
    .map((r) => {
      const color =
        r.pct >= 100 ? "var(--c-green)" : r.pct >= 50 ? "var(--c-blue)" : "var(--c-orange)";
      const meta = archived
        ? t("archived {0}", fmtDate(r.archivedAt))
        : r.durationDays !== undefined
          ? t("{0} days open", r.durationDays)
          : "";
      return `<div class="brow">
        <div class="brow-id" title="${escapeHtml(r.project)} · ${escapeHtml(r.id)}">${escapeHtml(r.id)}</div>
        <div class="brow-track"><div class="brow-fill" style="width:${r.pct}%;background:${color}"></div></div>
        <div class="brow-num">${r.done}/${r.total} · ${r.pct}%</div>
        <div class="brow-meta">${escapeHtml(meta)}</div>
      </div>`;
    })
    .join("");
  return `<div class="blist">${items}</div>`;
}

/** Color según el porcentaje de avance. */
function colorForPct(pct: number): string {
  if (pct >= 100) return "var(--c-green)";
  if (pct >= 75) return "var(--c-teal)";
  if (pct >= 50) return "var(--c-blue)";
  if (pct >= 25) return "var(--c-orange)";
  return "var(--c-red)";
}

/**
 * Mapa de progreso lineal: una franja con un segmento por cambio (ancho ∝ nº de
 * tareas), cada uno relleno según su avance y coloreado por estado.
 */
function progressMapView(rows: ChangeRow[]): string {
  if (rows.length === 0) {
    return "";
  }
  const segments = rows
    .map((r) => {
      const grow = r.total > 0 ? r.total : 1;
      const color = colorForPct(r.pct);
      return `<div class="seg" style="flex-grow:${grow}" title="${escapeHtml(r.id)} — ${r.done}/${r.total} · ${r.pct}%">
        <div class="seg-fill" style="width:${r.pct}%;background:${color}"></div>
        <span class="seg-label">${escapeHtml(r.id)}</span>
      </div>`;
    })
    .join("");
  const legend = rows
    .map(
      (r) =>
        `<span class="lg"><i class="dot" style="background:${colorForPct(r.pct)}"></i>${escapeHtml(r.id)} <b>${r.pct}%</b></span>`
    )
    .join("");
  return `<div class="pmap">${segments}</div><div class="pmap-legend">${legend}</div>`;
}

/** Trunca un texto a n caracteres con elipsis. */
function trunc(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

/**
 * Mind map (nodos conectados en SVG): raíz "Activos" → rama por cambio →
 * hoja por sección de tareas. Cada nodo se colorea según su avance.
 */
function mindMapView(s: Section, t: typeof vscode.l10n.t): string {
  const rows = s.rows;
  if (rows.length === 0) {
    return `<p class="empty">${t("No changes to show here.")}</p>`;
  }
  const rowH = 30;
  const padTop = 24;
  const nodeH = 22;
  // Columnas (x, ancho) para raíz, cambios y hojas.
  const root = { x: 8, w: 150 };
  const change = { x: 210, w: 210 };
  const leaf = { x: 470, w: 236 };
  const viewW = 720;

  // Distribución vertical: cada cambio ocupa max(1, nº secciones) filas.
  let y = padTop;
  const layout = rows.map((r) => {
    const count = Math.max(1, r.sections.length);
    const top = y;
    const centerY = top + (count * rowH) / 2;
    const leaves = r.sections.map((sec, i) => ({
      sec,
      y: top + i * rowH + rowH / 2,
    }));
    y += count * rowH;
    return { r, centerY, leaves };
  });
  const height = y + padTop;
  const rootY = height / 2;

  // Conector cúbico entre el borde derecho de un nodo y el izquierdo del hijo.
  const edge = (x1: number, y1: number, x2: number, y2: number): string => {
    const mx = (x1 + x2) / 2;
    return `<path class="mm-edge" d="M ${x1} ${y1} C ${mx} ${y1}, ${mx} ${y2}, ${x2} ${y2}" />`;
  };

  const node = (
    x: number,
    cy: number,
    w: number,
    label: string,
    pct: number,
    maxChars: number
  ): string => {
    const color = colorForPct(pct);
    const top = cy - nodeH / 2;
    return `<g>
      <rect x="${x}" y="${top}" width="${w}" height="${nodeH}" rx="6" class="mm-node" style="stroke:${color}"/>
      <rect x="${x}" y="${top}" width="4" height="${nodeH}" style="fill:${color}"/>
      <text x="${x + 12}" y="${cy + 4}" class="mm-text">${escapeHtml(trunc(label, maxChars))}</text>
      <text x="${x + w - 8}" y="${cy + 4}" text-anchor="end" class="mm-pct">${pct}%</text>
    </g>`;
  };

  const edges: string[] = [];
  const nodes: string[] = [];
  const rootRight = root.x + root.w;
  const changeRight = change.x + change.w;

  for (const cl of layout) {
    // raíz → cambio
    edges.push(edge(rootRight, rootY, change.x, cl.centerY));
    nodes.push(node(change.x, cl.centerY, change.w, cl.r.id, cl.r.pct, 24));
    // cambio → hojas (secciones)
    for (const lf of cl.leaves) {
      edges.push(edge(changeRight, cl.centerY, leaf.x, lf.y));
      nodes.push(node(leaf.x, lf.y, leaf.w, lf.sec.title, lf.sec.pct, 30));
    }
  }
  // Nodo raíz al final para que quede encima de los conectores.
  const rootNode = node(
    root.x,
    rootY,
    root.w,
    t("Active"),
    s.pctComplete,
    16
  );

  return `<div class="mm-wrap">
    <svg viewBox="0 0 ${viewW} ${height}" width="${viewW}" height="${height}" role="img">
      ${edges.join("")}
      ${nodes.join("")}
      ${rootNode}
    </svg>
  </div>`;
}

/** Barras verticales de velocidad (tareas completadas por semana). */
function velocityChart(
  velocity: Array<[string, number]>,
  t: typeof vscode.l10n.t
): string {
  const max = Math.max(1, ...velocity.map(([, v]) => v));
  const bars = velocity
    .map(([week, v]) => {
      const h = Math.round((v / max) * 100);
      const short = week.slice(5); // MM-DD
      return `<div class="mbar" title="${t("week of {0}", week)}">
        <div class="mbar-track"><div class="mbar-fill" style="height:${h}%;background:var(--c-blue)"></div><span class="mbar-val">${v}</span></div>
        <div class="mbar-label">${escapeHtml(short)}</div>
      </div>`;
    })
    .join("");
  return `<div class="months">${bars}</div>`;
}

/** Barras verticales de cambios por mes. */
function monthChart(
  byMonth: Array<[string, number]>,
  t: typeof vscode.l10n.t
): string {
  if (byMonth.length === 0) {
    return `<p class="empty">${t("No dated changes.")}</p>`;
  }
  const max = Math.max(1, ...byMonth.map(([, v]) => v));
  const bars = byMonth
    .map(([m, v]) => {
      const h = Math.round((v / max) * 100);
      return `<div class="mbar">
        <div class="mbar-track"><div class="mbar-fill" style="height:${h}%"></div><span class="mbar-val">${v}</span></div>
        <div class="mbar-label">${escapeHtml(m)}</div>
      </div>`;
    })
    .join("");
  return `<div class="months">${bars}</div>`;
}

/** Tabla de detalle con fechas y duración. */
function detailTable(
  rows: ChangeRow[],
  archived: boolean,
  _timeField: keyof ChangeRow,
  t: typeof vscode.l10n.t
): string {
  const head = archived
    ? `<tr><th>${t("Change")}</th><th>${t("Created")}</th><th>${t("Archived")}</th><th>${t("Duration")}</th><th>${t("Progress")}</th></tr>`
    : `<tr><th>${t("Change")}</th><th>${t("Created")}</th><th>${t("Last activity")}</th><th>${t("Age")}</th><th>${t("Progress")}</th></tr>`;
  const body = rows
    .map((r) => {
      const c1 = fmtDate(r.createdAt);
      const c2 = archived ? fmtDate(r.archivedAt) : fmtDate(r.updatedAt);
      const dur =
        r.durationDays !== undefined ? t("{0} days", r.durationDays) : "—";
      return `<tr>
        <td title="${escapeHtml(r.project)}">${escapeHtml(r.id)}</td>
        <td>${c1}</td><td>${c2}</td><td>${dur}</td>
        <td>${r.done}/${r.total} · ${r.pct}%</td>
      </tr>`;
    })
    .join("");
  return `<div class="table-wrap"><table>${head}${body}</table></div>`;
}

const STYLES = `
  :root {
    --c-green: var(--vscode-charts-green, #4caf50);
    --c-teal: var(--vscode-charts-green, #26a69a);
    --c-blue: var(--vscode-charts-blue, #2196f3);
    --c-orange: var(--vscode-charts-orange, #ff9800);
    --c-red: var(--vscode-charts-red, #f44336);
    --c-purple: var(--vscode-charts-purple, #9c27b0);
    --track: var(--vscode-editorWidget-border, rgba(128,128,128,0.3));
  }
  body {
    font-family: var(--vscode-font-family);
    color: var(--vscode-foreground);
    background: var(--vscode-editor-background);
    padding: 0 20px 40px;
    max-width: 1100px; margin: 0 auto;
  }
  .top { display: flex; align-items: center; justify-content: space-between;
    position: sticky; top: 0; background: var(--vscode-editor-background);
    padding: 14px 0; border-bottom: 1px solid var(--track); z-index: 5; }
  .top h1 { font-size: 18px; margin: 0; }
  .top-right { display: flex; align-items: center; gap: 12px; }
  .muted { color: var(--vscode-descriptionForeground); font-size: 12px; }
  .btn {
    background: var(--vscode-button-background); color: var(--vscode-button-foreground);
    border: none; padding: 5px 12px; border-radius: 4px; cursor: pointer; font-size: 12px;
  }
  .btn:hover { background: var(--vscode-button-hoverBackground); }

  .tabs { display: flex; gap: 4px; margin: 16px 0; }
  .tab {
    background: transparent; color: var(--vscode-foreground);
    border: none; border-bottom: 2px solid transparent;
    padding: 8px 14px; cursor: pointer; font-size: 13px;
  }
  .tab .count {
    background: var(--track); border-radius: 8px; padding: 0 7px;
    font-size: 11px; margin-left: 4px;
  }
  .tab.active { border-bottom-color: var(--c-blue); color: var(--vscode-textLink-foreground); }
  .panel { display: none; }
  .panel.active { display: block; }
  .empty { color: var(--vscode-descriptionForeground); padding: 20px 0; }

  .kpis { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; margin-bottom: 16px; }
  .kpi { background: var(--vscode-editorWidget-background, rgba(128,128,128,0.08));
    border: 1px solid var(--track); border-radius: 8px; padding: 14px; }
  .kpi-value { font-size: 26px; font-weight: 600; }
  .kpi-label { font-size: 12px; color: var(--vscode-descriptionForeground); margin-top: 2px; }
  .kpi-sub { font-size: 11px; color: var(--c-green); margin-top: 4px; }

  .grid-2 { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
  .card { background: var(--vscode-editorWidget-background, rgba(128,128,128,0.08));
    border: 1px solid var(--track); border-radius: 8px; padding: 16px; margin-bottom: 12px; }
  .card h3 { margin: 0 0 12px; font-size: 13px; font-weight: 600;
    color: var(--vscode-descriptionForeground); text-transform: uppercase; letter-spacing: 0.04em; }

  .donut-wrap { display: flex; align-items: center; gap: 20px; flex-wrap: wrap; }
  .donut-pct { font-size: 24px; font-weight: 700; fill: var(--vscode-foreground); }
  .donut-sub { font-size: 12px; fill: var(--vscode-descriptionForeground); }
  .legend { display: flex; flex-direction: column; gap: 6px; font-size: 12px; }
  .dot { display: inline-block; width: 10px; height: 10px; border-radius: 50%; margin-right: 6px; }

  .hist { display: flex; align-items: flex-end; gap: 10px; height: 160px; }
  .hbar { flex: 1; display: flex; flex-direction: column; align-items: center; height: 100%; }
  .hbar-track { flex: 1; width: 100%; display: flex; align-items: flex-end; position: relative; }
  .hbar-fill { width: 100%; background: var(--c-blue); border-radius: 4px 4px 0 0; min-height: 2px; }
  .hbar-val { position: absolute; top: -16px; left: 0; right: 0; text-align: center; font-size: 11px; }
  .hbar-label { font-size: 10px; color: var(--vscode-descriptionForeground); margin-top: 6px; }

  .blist { display: flex; flex-direction: column; gap: 8px; max-height: 340px; overflow-y: auto; }
  .brow { display: grid; grid-template-columns: 180px 1fr 90px 120px; align-items: center; gap: 10px; }
  .brow-id { font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .brow-track { height: 10px; background: var(--track); border-radius: 5px; overflow: hidden; }
  .brow-fill { height: 100%; border-radius: 5px; }
  .brow-num { font-size: 11px; color: var(--vscode-descriptionForeground); text-align: right; }
  .brow-meta { font-size: 11px; color: var(--vscode-descriptionForeground); }

  .months { display: flex; align-items: flex-end; gap: 12px; height: 150px; overflow-x: auto; padding-bottom: 4px; }
  .mbar { min-width: 44px; display: flex; flex-direction: column; align-items: center; height: 100%; }
  .mbar-track { flex: 1; width: 26px; display: flex; align-items: flex-end; position: relative; }
  .mbar-fill { width: 100%; background: var(--c-purple); border-radius: 4px 4px 0 0; min-height: 2px; }
  .mbar-val { position: absolute; top: -16px; left: -8px; right: -8px; text-align: center; font-size: 11px; }
  .mbar-label { font-size: 10px; color: var(--vscode-descriptionForeground); margin-top: 6px; white-space: nowrap; }

  .pmap { display: flex; gap: 3px; height: 46px; border-radius: 6px; overflow: hidden; }
  .seg { position: relative; min-width: 60px; background: var(--track);
    border-radius: 4px; overflow: hidden; display: flex; align-items: center; }
  .seg-fill { position: absolute; left: 0; top: 0; bottom: 0; opacity: 0.85; }
  .seg-label { position: relative; z-index: 1; font-size: 11px; padding: 0 8px;
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    color: var(--vscode-foreground); mix-blend-mode: normal; }
  .pmap-legend { display: flex; flex-wrap: wrap; gap: 10px 16px; margin-top: 12px; font-size: 11px; }
  .pmap-legend .lg { color: var(--vscode-descriptionForeground); }
  .pmap-legend b { color: var(--vscode-foreground); }

  .mindmap-card summary { cursor: pointer; list-style: none; }
  .mindmap-card summary h3 { display: inline; }
  .mindmap-card summary::-webkit-details-marker { display: none; }
  .mm-wrap { overflow: auto; max-height: 560px; margin-top: 10px; }
  .mm-edge { fill: none; stroke: var(--track); stroke-width: 1.5; }
  .mm-node { fill: var(--vscode-editor-background); stroke-width: 1.5; }
  .mm-text { fill: var(--vscode-foreground); font-size: 11px; }
  .mm-pct { fill: var(--vscode-descriptionForeground); font-size: 10px; }

  .table-wrap { overflow-x: auto; }
  table { border-collapse: collapse; width: 100%; font-size: 12px; }
  th, td { text-align: left; padding: 6px 10px; border-bottom: 1px solid var(--track); }
  th { color: var(--vscode-descriptionForeground); font-weight: 600; }

  @media (max-width: 720px) {
    .kpis { grid-template-columns: repeat(2, 1fr); }
    .grid-2 { grid-template-columns: 1fr; }
    .brow { grid-template-columns: 120px 1fr 70px; }
    .brow-meta { display: none; }
  }
`;
