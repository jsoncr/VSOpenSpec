// Panel webview reutilizable para previsualizar artefactos OpenSpec.
import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import MarkdownIt from "markdown-it";
import { ArtifactFile } from "../openspec/model";
import {
  OpenQuestion,
  parseQuestions,
  planQuestionAnswer,
} from "../openspec/questions";
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

/**
 * Clave de borrador sin colisión: [texto, ocurrencia] serializado.
 * La ocurrencia la calcula el parser contando TODOS los candidatos del
 * archivo (pendientes o resueltos), así que no se reasigna al guardar una
 * duplicada; si un cambio externo borra una duplicada, la clave cambia y el
 * borrador queda huérfano (se poda, nunca se traspasa a otra pregunta).
 */
function questionKey(question: OpenQuestion): string {
  return JSON.stringify([question.text, question.occurrence]);
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
  /** Scroll pendiente de aplicar en cuanto el webview esté listo. */
  private pendingScroll?: { type: string; line: number };
  /** Snapshot del contenido mostrado (para detectar cambios externos). */
  private contentSnapshot = "";
  /** true si el artefacto actual admite responder preguntas (activo escaneado). */
  private editable = false;
  /** Preguntas pendientes renderizadas, con su clave estable de borrador. */
  private renderedQuestions: Array<{ question: OpenQuestion; key: string }> = [];
  /** Token único por render: los mensajes del webview deben referenciarlo. */
  private renderToken = "";
  /** true mientras hay un guardado de respuesta en curso (anti doble clic). */
  private savingAnswer = false;
  /** Contenido resultante del último guardado propio (cubre al watcher). */
  private ownSave?: { fsPath: string; content: string };
  /** Último contenido renderizado por archivo + generación de borradores. */
  private renderedFiles = new Map<string, { content: string; rev: number }>();
  /** Generación de borradores del archivo actualmente renderizado. */
  private draftRev = 0;

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

  /**
   * Abre (o reutiliza) el panel para mostrar un artefacto. Si se indica
   * questionLine, hace scroll y foco al formulario de esa pregunta.
   */
  static show(
    extensionUri: vscode.Uri,
    artifact: ArtifactFile,
    onTaskToggled?: () => void,
    questionLine?: number
  ): void {
    if (!PreviewPanel.current) {
      PreviewPanel.current = new PreviewPanel(extensionUri);
    }
    const panel = PreviewPanel.current;
    panel.onTaskToggled = onTaskToggled;
    panel.render(artifact);
    if (typeof questionLine === "number") {
      panel.requestScroll({ type: "scrollToQuestion", line: questionLine });
    }
    panel.panel.reveal(vscode.ViewColumn.Beside);
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
    panel.requestScroll({ type: "scrollToTask", line });
    // preserveFocus=true: revelamos el preview sin robar el foco del árbol.
    panel.panel.reveal(vscode.ViewColumn.Beside, true);
  }

  /** Solicita scroll; si el webview aún no está listo, queda pendiente. */
  private requestScroll(scroll: { type: string; line: number }): void {
    if (this.ready) {
      this.postScroll(scroll);
    } else {
      this.pendingScroll = scroll;
    }
  }

  private postScroll(scroll: { type: string; line: number }): void {
    void this.panel.webview.postMessage(scroll);
  }

  private render(artifact: ArtifactFile): void {
    const sameArtifact =
      !!this.artifact && this.artifact.fsPath === artifact.fsPath;
    this.artifact = artifact;
    this.panel.title = `OpenSpec · ${artifact.label}`;

    let content = "";
    let readError = false;
    try {
      content = fs.readFileSync(artifact.fsPath, "utf8");
    } catch {
      readError = true;
      content = "_" + vscode.l10n.t("Could not read the file.") + "_";
    }

    // El permiso de edición se propaga solo desde artefactos activos
    // escaneados (presencia de `questions`, incluso vacío); nunca se deduce
    // de la ruta ni de mensajes del webview.
    const editable = artifact.questions !== undefined && !readError;

    // Guard conservador de borradores por archivo: si el contenido cambió y
    // no coincide con un guardado propio calculado, es un cambio externo que
    // puede reindexar ocurrencias de preguntas duplicadas (borrar la primera
    // reindexa la segunda a 0 y le traspasaría su borrador). Se incrementa la
    // generación del archivo y el webview descarta el bucket anterior entero
    // —afecta también a preguntas únicas, preferible a traspasar un borrador.
    const prev = this.renderedFiles.get(artifact.fsPath);
    const unchanged = prev !== undefined && prev.content === content;
    // El guardado propio registra el texto sin BOM.
    const stripped =
      content.charCodeAt(0) === 0xfeff ? content.slice(1) : content;
    const isOwnSave =
      this.ownSave?.fsPath === artifact.fsPath &&
      this.ownSave.content === stripped;
    if (isOwnSave) {
      this.ownSave = undefined; // se consume al primer re-render
    }
    let draftRev = prev?.rev ?? 0;
    if (prev && !unchanged && !isOwnSave) {
      draftRev += 1;
    }

    if (
      sameArtifact &&
      !readError &&
      this.editable === editable &&
      unchanged
    ) {
      // Contenido idéntico: se conserva el HTML (y los borradores) del webview.
      return;
    }
    if (!sameArtifact) {
      // Otro artefacto: se descarta el scroll pendiente del archivo anterior.
      this.pendingScroll = undefined;
    }

    // Al recargar el HTML el webview vuelve a inicializarse: dejará de estar
    // listo hasta que reenvíe el mensaje 'ready'.
    this.ready = false;
    this.editable = editable;
    this.contentSnapshot = content;
    this.draftRev = draftRev;
    this.renderedFiles.set(artifact.fsPath, { content, rev: draftRev });
    this.renderToken = makeNonce();
    this.renderedQuestions = editable
      ? parseQuestions(content).map((question) => ({
          question,
          key: questionKey(question),
        }))
      : [];

    const questionsBlock =
      this.renderedQuestions.length > 0
        ? this.renderQuestionsBlock(this.renderedQuestions)
        : "";
    const body =
      artifact.kind === "tasks"
        ? this.renderTasks(content)
        : `${questionsBlock}<div class="markdown-body">${md.render(
            content
          )}</div>`;

    this.panel.webview.html = this.htmlShell(body, artifact);
  }

  /** Sección editable con un formulario por pregunta pendiente del archivo. */
  private renderQuestionsBlock(
    entries: Array<{ question: OpenQuestion; key: string }>
  ): string {
    const items = entries
      .map(({ question, key }, i) => {
        const id = `answer-${i}`;
        const location = vscode.l10n.t("line {0}", question.line + 1);
        return `
      <div class="question" data-question-line="${question.line}">
        <label class="question-label" for="${id}">
          <span class="question-text">${escapeHtml(question.text)}</span>
          <span class="question-line">${escapeHtml(location)}</span>
        </label>
        <textarea id="${id}" data-qkey="${escapeHtml(key)}" rows="3"
          placeholder="${escapeHtml(vscode.l10n.t("Type the answer…"))}"></textarea>
        <button type="button" class="answer-btn" data-line="${question.line}"
          data-qkey="${escapeHtml(key)}">${escapeHtml(
            vscode.l10n.t("Save answer")
          )}</button>
      </div>`;
      })
      .join("");
    return `
    <section class="questions-block">
      <h2 class="questions-title">${escapeHtml(
        vscode.l10n.t("Open Questions")
      )}</h2>
      ${items}
    </section>`;
  }

  /** Render especial de tasks.md con barra de progreso y checkboxes clicables. */
  private renderTasks(content: string): string {
    const sections = parseTasks(content);
    const stats = computeStats(sections);
    const pct = stats.total > 0 ? Math.round((stats.done / stats.total) * 100) : 0;

    const header = `
      <div class="progress-header">
        <div class="progress-label">
          <strong>${stats.done}/${stats.total}</strong> ${escapeHtml(
            vscode.l10n.t("tasks completed")
          )}
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
            <span class="task-text" data-line="${task.line}" title="${escapeHtml(
              vscode.l10n.t("Double-click to open tasks.md at this line")
            )}">${escapeHtml(task.text)}</span>
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

  private handleMessage(msg: {
    type?: string;
    line?: number;
    renderId?: string;
    answer?: string;
  }): void {
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
    } else if (msg?.type === "answerQuestion") {
      void this.saveAnswer(msg);
    } else if (msg?.type === "ready") {
      // Solo vale el 'ready' del render vigente: un HTML antiguo no marca
      // el panel como listo ni consume el scroll pendiente.
      if (msg.renderId !== this.renderToken) {
        return;
      }
      this.ready = true;
      if (this.pendingScroll !== undefined) {
        this.postScroll(this.pendingScroll);
        this.pendingScroll = undefined;
      }
    }
  }

  /**
   * Guarda la respuesta de una pregunta en el .md del artefacto.
   * Rechaza mensajes obsoletos, líneas desconocidas, respuestas vacías,
   * archivos dirty o cambiados (en disco o en el documento) desde el render.
   */
  private async saveAnswer(msg: {
    type?: string;
    renderId?: string;
    line?: number;
    answer?: string;
  }): Promise<void> {
    // Solo se aceptan mensajes del render vigente del propio panel; el
    // webview no envía rutas: siempre se trabaja sobre el artefacto actual.
    if (msg.renderId !== this.renderToken || this.savingAnswer) {
      return;
    }
    const entry = this.renderedQuestions.find(
      (e) => e.question.line === msg.line
    );
    if (!entry) {
      return; // línea inválida u obsoleta
    }
    const answer = typeof msg.answer === "string" ? msg.answer.trim() : "";
    if (!answer) {
      vscode.window.showErrorMessage(
        vscode.l10n.t("The answer is empty.")
      );
      return;
    }

    // Captura síncrona del estado vigente ANTES del primer await: el panel
    // puede re-renderizarse mientras tanto y this.* quedaría obsoleto.
    const fsPath = this.artifact.fsPath;
    const renderId = this.renderToken;
    const snapshot = this.contentSnapshot; // raw, con BOM si lo hubiera
    // VS Code separa el BOM del texto del documento: se compara sin él.
    const expected = snapshot.replace(/^\uFEFF/, "");
    const unsavedError = () =>
      vscode.window.showErrorMessage(
        vscode.l10n.t(
          "{0} has unsaved changes. Save or revert them before answering.",
          path.basename(fsPath)
        )
      );
    const changedError = () => {
      vscode.window.showErrorMessage(
        vscode.l10n.t(
          "The file changed since the preview was rendered. It will be refreshed."
        )
      );
      // El refresh solo aplica si el panel sigue en el mismo artefacto.
      if (this.artifact.fsPath === fsPath) {
        PreviewPanel.refreshCurrent();
      }
    };
    // Desajuste detectado DESPUÉS de aplicar la edición: ya no se confía en
    // el rango insertado (podría borrar texto del usuario), así que no se
    // aplica otra edición ni se guarda; se pide revisión manual del editor.
    const manualReviewError = () =>
      vscode.window.showErrorMessage(
        vscode.l10n.t(
          "The file changed while the answer was being applied. Nothing was saved; review the file in the editor."
        )
      );

    this.savingAnswer = true;
    try {
      const doc = await vscode.workspace.openTextDocument(
        vscode.Uri.file(fsPath)
      );
      // Si el panel cambió de render/archivo durante el await, se rechaza.
      if (this.renderToken !== renderId || this.artifact.fsPath !== fsPath) {
        return;
      }
      if (doc.isDirty) {
        unsavedError();
        return;
      }
      // El documento abierto debe contener exactamente el snapshot.
      if (doc.getText() !== expected) {
        changedError();
        return;
      }
      // Lectura vigente de DISCO: VS Code puede seguir mostrando el documento
      // anterior si el archivo cambió fuera sin recargar; no se sobrescribe.
      let diskText: string;
      try {
        diskText = fs.readFileSync(fsPath, "utf8");
      } catch {
        vscode.window.showErrorMessage(
          vscode.l10n.t("Could not save the answer: {0}", fsPath)
        );
        return;
      }
      if (diskText !== snapshot) {
        changedError(); // comparación exacta, BOM incluido
        return;
      }
      // El plan se calcula sobre el mismo contenido validado (sin BOM).
      const plan = planQuestionAnswer(expected, entry.question, answer);
      if (!plan) {
        vscode.window.showErrorMessage(
          vscode.l10n.t(
            "The question is no longer pending or its block changed. The preview will be refreshed."
          )
        );
        if (this.artifact.fsPath === fsPath) {
          PreviewPanel.refreshCurrent();
        }
        return;
      }
      // Revalidación justo antes de aplicar: no pisar ediciones externas.
      if (doc.isDirty) {
        unsavedError();
        return;
      }
      const position = new vscode.Position(plan.line, plan.character);
      // expectedAfter por inserción directa sobre el snapshot (sin reparseo).
      const offset = doc.offsetAt(position);
      const expectedAfter =
        expected.slice(0, offset) + plan.text + expected.slice(offset);
      const edit = new vscode.WorkspaceEdit();
      edit.insert(doc.uri, position, plan.text);
      const applied = await vscode.workspace.applyEdit(edit);
      if (!applied) {
        vscode.window.showErrorMessage(
          vscode.l10n.t("Could not apply the edit to insert the answer.")
        );
        return;
      }
      // El documento debe ser snapshot + exactamente UNA inserción; si hay
      // cambios ajenos entremedio no se edita de nuevo ni se guarda.
      if (doc.getText() !== expectedAfter) {
        manualReviewError();
        return;
      }
      // Si el disco cambió tras aplicar (edición externa), tampoco se guarda.
      try {
        if (fs.readFileSync(fsPath, "utf8") !== snapshot) {
          manualReviewError();
          return;
        }
      } catch {
        manualReviewError();
        return;
      }
      // Marca el contenido resultante de ESTE guardado ANTES de doc.save():
      // si el watcher dispara antes del re-render no se toma por cambio externo.
      this.ownSave = { fsPath, content: expectedAfter };
      const saved = await doc.save();
      if (!saved) {
        this.ownSave = undefined;
        vscode.window.showErrorMessage(
          vscode.l10n.t("Could not save {0}.", path.basename(fsPath))
        );
        return;
      }
      vscode.window.showInformationMessage(vscode.l10n.t("Answer saved."));
      if (this.onTaskToggled) {
        this.onTaskToggled();
      }
      // Solo se re-renderiza si el panel sigue mostrando este artefacto.
      if (this.artifact.fsPath === fsPath) {
        PreviewPanel.refreshCurrent();
      }
    } catch (err) {
      vscode.window.showErrorMessage(
        vscode.l10n.t(
          "Could not save the answer: {0}",
          err instanceof Error ? err.message : String(err)
        )
      );
    } finally {
      this.savingAnswer = false;
    }
  }

  private htmlShell(body: string, artifact: ArtifactFile): string {
    const nonce = makeNonce();
    const csp = `default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';`;
    const fileName = escapeHtml(path.basename(artifact.fsPath));

    return `<!DOCTYPE html>
<html lang="${escapeHtml(vscode.env.language || "en")}">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="${csp}" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<style>${STYLES}</style>
</head>
<body data-path="${escapeHtml(artifact.fsPath)}" data-rev="${this.draftRev}">
  <div class="breadcrumb">${fileName}</div>
  ${body}
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const RENDER_ID = "${this.renderToken}";

    // Borradores aislados POR ARCHIVO (bucket por data-path): dos artefactos
    // con preguntas idénticas no comparten borrador. Se podan al cargar las
    // claves de este archivo que ya no están renderizadas; los demás buckets
    // se conservan para cuando el panel vuelva a ese artefacto. Cada bucket
    // lleva una REVISIÓN (data-rev): si el host detecta un cambio externo la
    // incrementa y el bucket anterior se descarta entero — así un borrador
    // nunca se traspasa a otra pregunta cuando se reindexan ocurrencias.
    const FILE_PATH = document.body.dataset.path || '';
    const DRAFT_REV = document.body.dataset.rev || '0';
    const qstate = vscode.getState() || {};
    const allDrafts = qstate.drafts || {};
    let bucket = allDrafts[FILE_PATH];
    if (!bucket || bucket.rev !== DRAFT_REV) {
      bucket = allDrafts[FILE_PATH] = { rev: DRAFT_REV, entries: {} };
    }
    const drafts = bucket.entries;
    const areas = Array.from(document.querySelectorAll('textarea[data-qkey]'));
    const present = new Set(areas.map((ta) => ta.dataset.qkey));
    Object.keys(drafts).forEach((k) => {
      if (!present.has(k)) { delete drafts[k]; }
    });
    const saveState = () => vscode.setState({ drafts: allDrafts });
    areas.forEach((ta) => {
      const k = ta.dataset.qkey;
      if (drafts[k] && !ta.value) { ta.value = drafts[k]; }
      ta.addEventListener('input', () => {
        if (ta.value.trim()) { drafts[k] = ta.value; }
        else { delete drafts[k]; }
        saveState();
      });
    });
    // Guardado de respuestas: deshabilita el botón unos segundos (anti doble
    // clic); el host además valida y re-renderiza tras guardar.
    document.querySelectorAll('button.answer-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const ta = areas.find((a) => a.dataset.qkey === btn.dataset.qkey);
        const answer = ta ? ta.value : '';
        if (!answer.trim()) { if (ta) { ta.focus(); } return; }
        btn.disabled = true;
        window.setTimeout(() => { btn.disabled = false; }, 4000);
        vscode.postMessage({
          type: 'answerQuestion',
          renderId: RENDER_ID,
          line: Number(btn.dataset.line),
          answer: answer
        });
      });
    });
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
      if (m.type === 'scrollToQuestion') {
        const el = document.querySelector('.question[data-question-line="' + m.line + '"]');
        if (el) {
          el.scrollIntoView({ behavior: 'smooth', block: 'center' });
          el.classList.add('flash');
          setTimeout(() => el.classList.remove('flash'), 1200);
          const ta = el.querySelector('textarea');
          if (ta) { ta.focus(); }
        }
      }
    });
    // Avisamos a la extensión que el webview está listo (ligado a este render).
    vscode.postMessage({ type: 'ready', renderId: RENDER_ID });
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

  /* Preguntas abiertas editables */
  .questions-block {
    margin: 0 0 22px;
    padding: 4px 16px 14px;
    border: 1px solid var(--vscode-panel-border);
    border-left: 3px solid var(--vscode-charts-yellow, #cca700);
    border-radius: 6px;
  }
  .questions-title {
    font-size: 13px;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--vscode-descriptionForeground);
    margin: 10px 0 4px;
    border-bottom: none;
    padding-bottom: 0;
  }
  .question { padding: 10px 0; border-top: 1px dashed var(--vscode-panel-border); border-radius: 5px; }
  .question:first-of-type { border-top: none; }
  .question-label { display: block; margin-bottom: 6px; }
  .question-line { float: right; font-size: 11px; color: var(--vscode-descriptionForeground); }
  .question textarea {
    width: 100%;
    box-sizing: border-box;
    font-family: var(--vscode-font-family);
    font-size: 12px;
    color: var(--vscode-input-foreground);
    background: var(--vscode-input-background);
    border: 1px solid var(--vscode-input-border, var(--vscode-panel-border));
    border-radius: 4px;
    padding: 6px 8px;
    resize: vertical;
  }
  .question textarea:focus { outline: 1px solid var(--vscode-focusBorder); }
  .answer-btn {
    margin-top: 6px;
    padding: 4px 14px;
    cursor: pointer;
    font-family: var(--vscode-font-family);
    color: var(--vscode-button-foreground);
    background: var(--vscode-button-background);
    border: none;
    border-radius: 4px;
  }
  .answer-btn:hover { background: var(--vscode-button-hoverBackground); }
  .answer-btn:disabled { opacity: 0.5; cursor: default; }
  .question.flash { animation: osflash 1.2s ease; }
`;
