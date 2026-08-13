// Punto de entrada de la extensión OpenSpec Previewer.
import * as path from "path";
import * as vscode from "vscode";
import { OpenSpecTreeProvider, OSNode } from "./tree/treeProvider";
import { PreviewPanel } from "./preview/previewPanel";
import { toggleTaskLine } from "./openspec/tasks";
import { Change, OpenSpecProject } from "./openspec/model";
import { createDeprecationChange } from "./openspec/deprecate";
import { DashboardPanel } from "./dashboard/dashboardPanel";
import { computeAnalytics } from "./dashboard/analytics";
import { activeSpecPathForDelta, capabilityOf } from "./openspec/paths";
import * as fs from "fs";
import { execFile } from "child_process";

/** Carpeta del proyecto = carpeta que contiene openspec/ (padre de rootPath). */
function projectCwdOf(project: OpenSpecProject): string {
  return path.dirname(project.rootPath);
}

/** Elige la carpeta de proyecto: única directa, o QuickPick si hay varias. */
async function pickProjectCwd(
  projects: OpenSpecProject[]
): Promise<string | undefined> {
  if (projects.length === 0) {
    vscode.window.showWarningMessage(
      vscode.l10n.t("No OpenSpec project was found in the workspace.")
    );
    return undefined;
  }
  if (projects.length === 1) {
    return projectCwdOf(projects[0]);
  }
  const items = projects.map((p) => ({
    label: p.name,
    description: projectCwdOf(p),
  }));
  const pick = await vscode.window.showQuickPick(items, {
    placeHolder: vscode.l10n.t("Select the OpenSpec project"),
  });
  return pick?.description;
}

/** Sanitiza el texto para inyectarlo dentro de comillas dobles en la terminal. */
function sanitizeForShell(text: string): string {
  return text.replace(/\r?\n/g, " ").replace(/"/g, '\\"').trim();
}

/** Deriva la carpeta del proyecto (padre de openspec/) a partir de la ruta de un cambio. */
function resolveProjectCwd(change: Change): string {
  const marker = `${path.sep}openspec${path.sep}`;
  const idx = change.dirPath.indexOf(marker);
  return idx >= 0 ? change.dirPath.substring(0, idx) : path.dirname(change.dirPath);
}

/** Sustituye las variables ${changeId} y ${cwd} en una plantilla de comando. */
function buildCommand(template: string, change: Change, cwd: string): string {
  return template
    .replace(/\$\{changeId\}/g, change.id)
    .replace(/\$\{cwd\}/g, cwd);
}

/** Abre (o enfoca) el archivo y coloca el cursor en la línea indicada. */
async function revealTaskInEditor(fsPath: string, line: number): Promise<void> {
  const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(fsPath));
  // showTextDocument abre el archivo si está cerrado, o le hace focus si ya está abierto.
  const editor = await vscode.window.showTextDocument(doc, { preview: false });
  const pos = new vscode.Position(Math.max(0, line), 0);
  const range = new vscode.Range(pos, pos);
  editor.selection = new vscode.Selection(pos, pos);
  editor.revealRange(range, vscode.TextEditorRevealType.InCenter);
}

/** Obtiene (o crea) la terminal integrada dedicada a OpenSpec en el cwd indicado. */
function getOpenSpecTerminal(cwd: string): vscode.Terminal {
  const name = "OpenSpec";
  const existing = vscode.window.terminals.find((t) => t.name === name);
  // Reutilizamos la terminal salvo que necesitemos otro cwd (no detectable a posteriori);
  // por simplicidad reutilizamos siempre y hacemos cd al cwd correcto.
  const terminal = existing ?? vscode.window.createTerminal({ name, cwd });
  return terminal;
}

export function activate(context: vscode.ExtensionContext): void {
  const treeProvider = new OpenSpecTreeProvider();

  const treeView = vscode.window.createTreeView("openspecExplorer", {
    treeDataProvider: treeProvider,
    showCollapseAll: true,
    // Gestionamos manualmente el estado de los checkboxes de tareas.
    manageCheckboxStateManually: true,
  });
  context.subscriptions.push(treeView);

  // Colección de diagnósticos para volcar los issues de validación al panel Problemas.
  const diagnostics = vscode.languages.createDiagnosticCollection("openspec");
  context.subscriptions.push(diagnostics);
  treeProvider.onValidated = (results, changes) => {
    diagnostics.clear();
    for (const change of changes) {
      const result = results.get(change.dirPath);
      if (!result || result.status !== "invalid") {
        continue;
      }
      // Agrupa issues por archivo (delta specs/<cap>/spec.md dentro del cambio).
      const byFile = new Map<string, vscode.Diagnostic[]>();
      for (const issue of result.issues) {
        const rel = issue.path ?? "";
        const target = rel
          ? path.join(change.dirPath, "specs", rel)
          : path.join(change.dirPath, "proposal.md");
        const sev =
          (issue.level ?? "ERROR").toUpperCase() === "ERROR"
            ? vscode.DiagnosticSeverity.Error
            : vscode.DiagnosticSeverity.Warning;
        const diag = new vscode.Diagnostic(
          new vscode.Range(0, 0, 0, 1),
          issue.message ?? vscode.l10n.t("Validation issue"),
          sev
        );
        diag.source = "openspec";
        const arr = byFile.get(target) ?? [];
        arr.push(diag);
        byFile.set(target, arr);
      }
      for (const [file, diags] of byFile) {
        diagnostics.set(vscode.Uri.file(file), diags);
      }
    }
  };

  // Detecta si la CLI de OpenSpec está disponible, para mostrar el botón correcto
  // en la vista de bienvenida (Inicializar vs Instalar).
  const detectCli = () => {
    execFile("openspec", ["--version"], { timeout: 5000 }, (error) => {
      vscode.commands.executeCommand(
        "setContext",
        "openspec.cliAvailable",
        !error
      );
    });
  };
  detectCli();

  // Primer escaneo.
  treeProvider.refresh();

  // --- Comandos ---

  context.subscriptions.push(
    vscode.commands.registerCommand("openspec.refresh", () => {
      treeProvider.refresh();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("openspec.preview", (node: OSNode) => {
      if (node?.artifact) {
        PreviewPanel.show(context.extensionUri, node.artifact, () =>
          treeProvider.refresh()
        );
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("openspec.openSource", (node: OSNode) => {
      if (node?.artifact) {
        vscode.window.showTextDocument(
          vscode.Uri.file(node.artifact.fsPath),
          { preview: true }
        );
      }
    })
  );

  // Ejecutar tareas pendientes de un cambio con el agente configurado.
  context.subscriptions.push(
    vscode.commands.registerCommand("openspec.runTasks", (node: OSNode) => {
      const change = node?.change;
      if (!change) {
        return;
      }
      const config = vscode.workspace.getConfiguration("openspec");
      const template = config.get<string>(
        "applyCommand",
        'claude "/openspec:apply ${changeId}"'
      );
      const autoRun = config.get<boolean>("autoRunApply", false);
      const cwd = resolveProjectCwd(change);
      const command = buildCommand(template, change, cwd);

      const terminal = getOpenSpecTerminal(cwd);
      terminal.show();
      // Nos aseguramos de estar en el directorio del proyecto.
      terminal.sendText(`cd "${cwd}"`, true);
      // Escribimos el comando; con autoRun=false NO se ejecuta (el usuario da Enter).
      terminal.sendText(command, autoRun);
      if (!autoRun) {
        vscode.window.setStatusBarMessage(
          vscode.l10n.t(
            "OpenSpec: command ready in the terminal — review it and press Enter to run."
          ),
          6000
        );
      }
    })
  );

  // Archivar un cambio completado (con confirmación modal).
  context.subscriptions.push(
    vscode.commands.registerCommand("openspec.archive", async (node: OSNode) => {
      const change = node?.change;
      if (!change) {
        return;
      }
      const stats = change.taskStats;
      const pending = stats ? stats.total - stats.done : 0;
      const warn =
        pending > 0
          ? " " + vscode.l10n.t("Warning: {0} task(s) still pending.", pending)
          : "";
      const archiveLabel = vscode.l10n.t("Archive");
      const choice = await vscode.window.showWarningMessage(
        vscode.l10n.t(
          'Archive change "{0}"?{1}\n\nIt will be moved to changes/archive and the main specs will be updated.',
          change.id,
          warn
        ),
        { modal: true },
        archiveLabel
      );
      if (choice !== archiveLabel) {
        return;
      }
      const config = vscode.workspace.getConfiguration("openspec");
      const template = config.get<string>(
        "archiveCommand",
        "openspec archive ${changeId} -y"
      );
      const cwd = resolveProjectCwd(change);
      const command = buildCommand(template, change, cwd);

      const terminal = getOpenSpecTerminal(cwd);
      terminal.show();
      terminal.sendText(`cd "${cwd}"`, true);
      // El usuario ya confirmó en el modal: ejecutamos directamente.
      terminal.sendText(command, true);
    })
  );

  // Cerrar una spec activa creando un change de deprecación (delta REMOVED).
  context.subscriptions.push(
    vscode.commands.registerCommand("openspec.closeSpec", async (node: OSNode) => {
      const spec = node?.spec;
      if (!spec) {
        return;
      }
      const createLabel = vscode.l10n.t("Create deprecation change");
      const choice = await vscode.window.showWarningMessage(
        vscode.l10n.t(
          'Close spec "{0}"?\n\nA deprecation change will be created with a REMOVED delta. The spec will be removed from the active specs when you archive that change (it is not deleted now).',
          spec.capability
        ),
        { modal: true },
        createLabel
      );
      if (choice !== createLabel) {
        return;
      }
      try {
        const result = createDeprecationChange(spec);
        treeProvider.refresh();
        // Abrimos la propuesta generada en el preview.
        PreviewPanel.show(
          context.extensionUri,
          {
            label: vscode.l10n.t("Proposal"),
            kind: "proposal",
            fsPath: result.proposalPath,
          },
          () => treeProvider.refresh()
        );
        vscode.window.showInformationMessage(
          vscode.l10n.t(
            "Deprecation change created: {0}. Review it and archive it to retire the spec.",
            result.changeId
          )
        );
      } catch (err) {
        vscode.window.showErrorMessage(
          vscode.l10n.t(
            "Could not create the deprecation change: {0}",
            err instanceof Error ? err.message : String(err)
          )
        );
      }
    })
  );

  // Instalar la CLI de OpenSpec globalmente (npm). Escribe el comando en la terminal.
  context.subscriptions.push(
    vscode.commands.registerCommand("openspec.install", () => {
      const folders = vscode.workspace.workspaceFolders ?? [];
      const cwd = folders[0]?.uri.fsPath;
      const terminal = getOpenSpecTerminal(cwd ?? process.cwd());
      terminal.show();
      // Escribimos el comando; el usuario lo ejecuta con Enter.
      terminal.sendText("npm install -g @fission-ai/openspec@latest", false);
      vscode.window.setStatusBarMessage(
        vscode.l10n.t(
          "OpenSpec: install command ready in the terminal — press Enter to run it."
        ),
        6000
      );
    })
  );

  // Inicializar OpenSpec en una carpeta del workspace que aún no lo tenga.
  context.subscriptions.push(
    vscode.commands.registerCommand("openspec.init", async () => {
      const folders = vscode.workspace.workspaceFolders ?? [];
      if (folders.length === 0) {
        vscode.window.showWarningMessage(
          vscode.l10n.t("Open a folder first to initialize OpenSpec.")
        );
        return;
      }
      let cwd = folders[0].uri.fsPath;
      if (folders.length > 1) {
        const pick = await vscode.window.showQuickPick(
          folders.map((f) => ({ label: f.name, description: f.uri.fsPath })),
          { placeHolder: vscode.l10n.t("Select the folder to initialize") }
        );
        if (!pick) {
          return;
        }
        cwd = pick.description;
      }
      const terminal = getOpenSpecTerminal(cwd);
      terminal.show();
      terminal.sendText(`cd "${cwd}"`, true);
      // Escribimos el comando; el usuario revisa el wizard y ejecuta con Enter.
      terminal.sendText("openspec init", false);
      vscode.window.setStatusBarMessage(
        vscode.l10n.t(
          "OpenSpec: 'openspec init' is ready in the terminal — press Enter to run the wizard."
        ),
        6000
      );
    })
  );

  // Filtro de cambios activos: todos / solo pendientes / solo completos.
  context.subscriptions.push(
    vscode.commands.registerCommand("openspec.filter", async () => {
      const options: Array<{ label: string; value: "all" | "pending" | "completed" }> = [
        { label: vscode.l10n.t("All changes"), value: "all" },
        { label: vscode.l10n.t("Only pending"), value: "pending" },
        { label: vscode.l10n.t("Only completed"), value: "completed" },
      ];
      const pick = await vscode.window.showQuickPick(
        options.map((o) => o.label),
        { placeHolder: vscode.l10n.t("Filter active changes") }
      );
      const found = options.find((o) => o.label === pick);
      if (found) {
        treeProvider.setFilter(found.value);
      }
    })
  );

  // Búsqueda por texto en el id del cambio.
  context.subscriptions.push(
    vscode.commands.registerCommand("openspec.search", async () => {
      const query = await vscode.window.showInputBox({
        title: vscode.l10n.t("Search changes"),
        prompt: vscode.l10n.t("Type to filter changes by id (empty to clear)"),
        value: treeProvider.getQuery(),
      });
      // undefined = cancelado; string vacío = limpiar.
      if (query !== undefined) {
        treeProvider.setQuery(query);
      }
    })
  );

  // Limpiar filtro y búsqueda.
  context.subscriptions.push(
    vscode.commands.registerCommand("openspec.clearFilter", () => {
      treeProvider.clearFilter();
    })
  );

  // Ver impacto: diff del spec delta contra la spec activa correspondiente.
  context.subscriptions.push(
    vscode.commands.registerCommand("openspec.showDelta", (node: OSNode) => {
      const delta = node?.artifact;
      if (!delta || delta.kind !== "spec") {
        return;
      }
      const cap = capabilityOf(delta.fsPath);
      const activePath = activeSpecPathForDelta(delta.fsPath);
      const deltaUri = vscode.Uri.file(delta.fsPath);

      if (activePath && fs.existsSync(activePath)) {
        // Izquierda: spec activa vigente. Derecha: delta propuesto.
        vscode.commands.executeCommand(
          "vscode.diff",
          vscode.Uri.file(activePath),
          deltaUri,
          vscode.l10n.t("{0}: active spec ↔ delta", cap)
        );
      } else {
        // No hay spec activa aún (capability nueva): mostramos el delta y avisamos.
        vscode.window.showInformationMessage(
          vscode.l10n.t(
            "No active spec exists yet for \"{0}\" (it will be created when the change is archived). Showing the proposed delta.",
            cap
          )
        );
        PreviewPanel.show(context.extensionUri, delta, () =>
          treeProvider.refresh()
        );
      }
    })
  );

  // Abrir el dashboard de análisis (stats y gráficos).
  context.subscriptions.push(
    vscode.commands.registerCommand("openspec.openDashboard", () => {
      DashboardPanel.show(() =>
        computeAnalytics(treeProvider.getProjects(), Date.now())
      );
    })
  );

  // Crear una nueva proposal: pide la descripción del requerimiento/cambio y
  // lanza el agente configurado (por defecto Claude Code) en la terminal.
  context.subscriptions.push(
    vscode.commands.registerCommand("openspec.createProposal", async () => {
      const cwd = await pickProjectCwd(treeProvider.getProjects());
      if (!cwd) {
        return;
      }
      const description = await vscode.window.showInputBox({
        title: vscode.l10n.t("New OpenSpec proposal"),
        prompt: vscode.l10n.t("Describe the requirement or change"),
        placeHolder: vscode.l10n.t(
          "e.g. Add email notifications when a task is completed"
        ),
        ignoreFocusOut: true,
        validateInput: (v) =>
          v.trim().length < 5
            ? vscode.l10n.t("Please enter a longer description.")
            : undefined,
      });
      if (!description) {
        return;
      }
      const config = vscode.workspace.getConfiguration("openspec");
      const template = config.get<string>(
        "proposalCommand",
        'claude "/openspec:proposal ${description}"'
      );
      const autoRun = config.get<boolean>("autoRunApply", false);
      const command = template
        .replace(/\$\{description\}/g, sanitizeForShell(description))
        .replace(/\$\{cwd\}/g, cwd);

      const terminal = getOpenSpecTerminal(cwd);
      terminal.show();
      terminal.sendText(`cd "${cwd}"`, true);
      terminal.sendText(command, autoRun);
      if (!autoRun) {
        vscode.window.setStatusBarMessage(
          vscode.l10n.t(
            "OpenSpec: command ready in the terminal — review it and press Enter to run."
          ),
          6000
        );
      }
    })
  );

  // Doble clic en una subtarea del árbol: detección manual por tiempo entre clics.
  let lastTaskClick: { key: string; time: number } | undefined;
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "openspec.taskClick",
      (fsPath?: string, line?: number) => {
        if (!fsPath || typeof line !== "number") {
          return;
        }
        const key = `${fsPath}:${line}`;
        const now = Date.now();
        const isDouble =
          lastTaskClick &&
          lastTaskClick.key === key &&
          now - lastTaskClick.time < 500;
        if (isDouble) {
          // Doble clic: abrir/focar el md fuente en la línea.
          lastTaskClick = undefined;
          void revealTaskInEditor(fsPath, line);
        } else {
          // Un clic: abrir/enfocar el preview y hacer scroll a la tarea.
          lastTaskClick = { key, time: now };
          PreviewPanel.showTask(
            context.extensionUri,
            { label: vscode.l10n.t("Tasks"), kind: "tasks", fsPath },
            line,
            () => treeProvider.refresh()
          );
        }
      }
    )
  );

  // Reveal directo (usado por el doble clic del preview).
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "openspec.revealTask",
      (fsPath: string, line: number) => {
        void revealTaskInEditor(fsPath, line);
      }
    )
  );

  // Comando interno usado por el preview para alternar una tarea.
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "openspec.toggleTaskLine",
      (fsPath: string, line: number) => {
        toggleTaskLine(fsPath, line);
        treeProvider.refresh();
      }
    )
  );

  // --- Checkboxes interactivos del árbol ---
  context.subscriptions.push(
    treeView.onDidChangeCheckboxState((e) => {
      for (const [node] of e.items) {
        if (node.kind === "task" && node.taskFsPath !== undefined) {
          toggleTaskLine(node.taskFsPath, node.taskLine!);
        }
      }
      treeProvider.refresh();
      PreviewPanel.refreshCurrent();
    })
  );

  // --- Auto-refresco al cambiar archivos openspec ---
  const watcher = vscode.workspace.createFileSystemWatcher(
    "**/openspec/**/*.{md,yaml}"
  );
  const onChange = () => {
    treeProvider.refresh();
    PreviewPanel.refreshCurrent();
    DashboardPanel.refreshCurrent();
  };
  watcher.onDidChange(onChange);
  watcher.onDidCreate(onChange);
  watcher.onDidDelete(onChange);
  context.subscriptions.push(watcher);
}

export function deactivate(): void {
  // Nada que limpiar manualmente; las suscripciones se liberan solas.
}
