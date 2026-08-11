// Panel webview reutilizable para previsualizar artefactos OpenSpec.
import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import MarkdownIt from "markdown-it";
import { ArtifactFile } from "../openspec/model";
import { computeStats, parseTasks } from "../openspec/tasks";

const md = new MarkdownIt({ html: false, linkify: true, breaks: false });

/** Genera un nonce para la Content-Security-Policy del webview. */
function makeNonce(): string {
  let text = "";
  const chars =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  for (let i = 0; i < 32; i++) {
    text += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return text;
}

/** Escapa texto para insertarlo de forma segura en HTML. */
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export class PreviewPanel {
  private static current: PreviewPanel | undefined;

  private readonly panel: vscode.WebviewPanel;
  private artifact!: ArtifactFile;
  /** Callback que se invoca cuando el usuario alterna una tarea desde el preview. */
  private onTaskToggled?: () => void;
  private disposables: vscode.Disposable[] = [];
  /** true cuando el webview ya cargó y puede recibir mensajes de scroll. */
  private ready = false;
  /** Línea pendiente de scroll a aplicar en cuanto el webview esté listo. */
  private pendingScrollLine?: number;

  private constructor(private readonly extensionUri: vscode.Uri) {
    this.panel = vscode.window.createWebviewPanel(
      "openspecPreview",
      "OpenSpec Preview",
      vscode.ViewColumn.Beside,
      { enableScripts: true, retainContextWhenHidden: true }
    );

    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);

    // Mensajes desde el webview (toggle de tareas).
    this.panel.webview.onDidReceiveMessage(
      (msg) => this.handleMessage(msg),
      null,
      this.disposables
    );
  }

  /** Abre (o reutiliza) el panel para mostrar un artefacto. */
  static show(
    extensionUri: vscode.Uri,
    artifact: ArtifactFile,
    onTaskToggled?: () => void
  ): void {
    if (!PreviewPanel.current) {
      PreviewPanel.current = new PreviewPanel(extensionUri);
    }
    PreviewPanel.current.onTaskToggled = onTaskToggled;
    PreviewPanel.current.render(artifact);
    PreviewPanel.current.panel.reveal(vscode.ViewColumn.Beside);
  }

  /** Vuelve a renderizar el artefacto actual (tras un cambio en disco). */
  static refreshCurrent(): void {
    if (PreviewPanel.current) {
      PreviewPanel.current.render(PreviewPanel.current.artifact);
    }
  }

  /**
   * Muestra el tasks.md indicado y hace scroll a la tarea de la línea dada.
   * Si el preview no está abierto, lo abre; si ya muestra ese archivo, no lo recarga.
   */
  static showTask(
    extensionUri: vscode.Uri,
    artifact: ArtifactFile,
    line: number,
    onTaskToggled?: () => void
  ): void {
    if (!PreviewPanel.current) {
      PreviewPanel.current = new PreviewPanel(extensionUri);
    }
    const panel = PreviewPanel.current;
    panel.onTaskToggled = onTaskToggled;
    const changed = !panel.artifact || panel.artifact.fsPath !== artifact.fsPath;
    if (changed) {
      panel.render(artifact);
    }
    panel.requestScroll(line);
    // preserveFocus=true: revelamos el preview sin robar el foco del árbol.
    panel.panel.reveal(vscode.ViewColumn.Beside, true);
  }

  /** Solicita scroll a una línea; si el webview aún no está listo, queda pendiente. */
  private requestScroll(line: number): void {
    if (this.ready) {
      this.postScroll(line);
    } else {
      this.pendingScrollLine = line;
    }
  }

  private postScroll(line: number): void {
    void this.panel.webview.postMessage({ type: "scrollToTask", line });
  }

  private render(artifact: ArtifactFile): void {
    this.artifact = artifact;
    // Al recargar el HTML el webview vuelve a inicializarse: dejará de estar listo
    // hasta que reenvíe el mensaje 'ready'.
    this.ready = false;
    this.panel.title = `OpenSpec · ${artifact.label}`;

    let content = "";
    try {
      content = fs.readFileSync(artifact.fsPath, "utf8");
    } catch {
      content = "_No se pudo leer el archivo._";
    }

    const body =
      artifact.kind === "tasks"
        ? this.renderTasks(content)
        : `<div class="markdown-body">${md.render(content)}</div>`;

    this.panel.webview.html = this.htmlShell(body, artifact);
  }

  /** Render especial de tasks.md con barra de progreso y checkboxes clicables. */
  private renderTasks(content: string): string {
    const sections = parseTasks(content);
    const stats = computeStats(sections);
    const pct = stats.total > 0 ? Math.round((stats.done / stats.total) * 100) : 0;

    const header = `
      <div class="progress-header">
        <div class="progress-label">
          <strong>${stats.done}/${stats.total}</strong> tareas completadas
          <span class="pct">${pct}%</span>
        </div>
        <div class="progress-bar"><div class="progress-fill" style="width:${pct}%"></div></div>
      </div>`;

    const sectionsHtml = sections
      .map((section) => {
        const items = section.tasks
          .map(
            (task) => `
          <li class="task ${task.done ? "done" : ""}">
            <input type="checkbox" ${task.done ? "checked" : ""} data-line="${task.line}" />
            <span class="task-text" data-line="${task.line}" title="Doble clic para abrir el tasks.md en esta línea">${escapeHtml(task.text)}</span>
          </li>`
          )
          .join("");
        return `
          <section class="task-section">
            <h3>${escapeHtml(section.title)}</h3>
            <ul class="task-list">${items}</ul>
          </section>`;
      })
      .join("");

    return `${header}<div class="tasks-container">${sectionsHtml}</div>`;
  }

  private handleMessage(msg: { type?: string; line?: number }): void {
    if (msg?.type === "toggleTask" && typeof msg.line === "number") {
      vscode.commands.executeCommand(
        "openspec.toggleTaskLine",
        this.artifact.fsPath,
        msg.line
      );
      // La reescritura dispara el watcher; refrescamos árbol y preview.
      if (this.onTaskToggled) {
        this.onTaskToggled();
      }
      PreviewPanel.refreshCurrent();
    } else if (msg?.type === "revealTask" && typeof msg.line === "number") {
      // Doble clic en el preview: abrir/focar el tasks.md en la línea.
      vscode.commands.executeCommand(
        "openspec.revealTask",
        this.artifact.fsPath,
        msg.line
      );
    } else if (msg?.type === "ready") {
      // El webview terminó de cargar: aplicamos el scroll pendiente si lo hay.
      this.ready = true;
      if (this.pendingScrollLine !== undefined) {
        this.postScroll(this.pendingScrollLine);
        this.pendingScrollLine = undefined;
      }
    }
  }

  private htmlShell(body: string, artifact: ArtifactFile): string {
    const nonce = makeNonce();
    const csp = `default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';`;
    const fileName = escapeHtml(path.basename(artifact.fsPath));

    return `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="${csp}" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<style>${STYLES}</style>
</head>
<body>
  <div class="breadcrumb">${fileName}</div>
  ${body}
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    document.querySelectorAll('input[type=checkbox][data-line]').forEach((cb) => {
      cb.addEventListener('change', () => {
        vscode.postMessage({ type: 'toggleTask', line: Number(cb.dataset.line) });
      });
    });
    // Doble clic sobre el texto abre el tasks.md en la línea correspondiente.
    document.querySelectorAll('.task-text[data-line]').forEach((el) => {
      el.addEventListener('dblclick', () => {
        vscode.postMessage({ type: 'revealTask', line: Number(el.dataset.line) });
      });
    });
    // Scroll + resaltado hacia una tarea concreta (solicitado desde el árbol).
    window.addEventListener('message', (e) => {
      const m = e.data || {};
      if (m.type === 'scrollToTask') {
        const el = document.querySelector('[data-line="' + m.line + '"]');
        if (el) {
          const row = el.closest('.task') || el;
          row.scrollIntoView({ behavior: 'smooth', block: 'center' });
          row.classList.add('flash');
          setTimeout(() => row.classList.remove('flash'), 1200);
        }
      }
    });
    // Avisamos a la extensión que el webview está listo para recibir mensajes.
    vscode.postMessage({ type: 'ready' });
  </script>
</body>
</html>`;
  }

  private dispose(): void {
    PreviewPanel.current = undefined;
    this.panel.dispose();
    while (this.disposables.length) {
      this.disposables.pop()?.dispose();
    }
  }
}

// Estilos basados en las variables de tema de VSCode para integrarse con light/dark.
const STYLES = `
  body {
    font-family: var(--vscode-font-family);
    color: var(--vscode-foreground);
    padding: 0 24px 40px;
    line-height: 1.55;
    max-width: 900px;
    margin: 0 auto;
  }
  .breadcrumb {
    position: sticky; top: 0;
    background: var(--vscode-editor-background);
    padding: 10px 0;
    font-size: 12px;
    color: var(--vscode-descriptionForeground);
    border-bottom: 1px solid var(--vscode-panel-border);
    margin-bottom: 16px;
    z-index: 5;
  }
  h1, h2, h3 { line-height: 1.3; }
  h1 { border-bottom: 1px solid var(--vscode-panel-border); padding-bottom: 6px; }
  a { color: var(--vscode-textLink-foreground); }
  code {
    background: var(--vscode-textCodeBlock-background);
    padding: 1px 5px; border-radius: 3px;
    font-family: var(--vscode-editor-font-family);
    font-size: 90%;
  }
  pre {
    background: var(--vscode-textCodeBlock-background);
    padding: 12px; border-radius: 6px; overflow-x: auto;
  }
  pre code { background: none; padding: 0; }
  blockquote {
    border-left: 3px solid var(--vscode-textBlockQuote-border);
    margin: 0; padding: 4px 14px;
    color: var(--vscode-descriptionForeground);
    background: var(--vscode-textBlockQuote-background);
  }
  table { border-collapse: collapse; width: 100%; }
  th, td { border: 1px solid var(--vscode-panel-border); padding: 6px 10px; }

  /* Progreso de tareas */
  .progress-header { margin: 8px 0 20px; }
  .progress-label { font-size: 14px; margin-bottom: 6px; }
  .progress-label .pct { float: right; color: var(--vscode-descriptionForeground); }
  .progress-bar {
    height: 8px; border-radius: 4px;
    background: var(--vscode-progressBar-background, rgba(128,128,128,0.25));
    overflow: hidden;
  }
  .progress-fill {
    height: 100%;
    background: var(--vscode-charts-green, #4caf50);
    transition: width 0.2s ease;
  }
  .task-section h3 {
    margin: 22px 0 8px;
    font-size: 14px;
    color: var(--vscode-descriptionForeground);
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }
  .task-list { list-style: none; padding: 0; margin: 0; }
  .task {
    display: flex; align-items: flex-start; gap: 10px;
    padding: 6px 8px; border-radius: 5px;
  }
  .task:hover { background: var(--vscode-list-hoverBackground); }
  .task input { margin-top: 3px; cursor: pointer; }
  .task.done .task-text {
    text-decoration: line-through;
    color: var(--vscode-descriptionForeground);
  }
  .task-text { cursor: default; }
  /* Resaltado temporal al navegar a una tarea desde el árbol. */
  .task.flash { animation: osflash 1.2s ease; }
  @keyframes osflash {
    0%, 100% { background: transparent; }
    25% { background: var(--vscode-editor-findMatchHighlightBackground, rgba(255,214,0,0.35)); }
  }
`;
