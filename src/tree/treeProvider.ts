// Provider del árbol de OpenSpec para la vista lateral.
import * as vscode from "vscode";
import {
  ActiveSpec,
  ArtifactFile,
  Change,
  OpenSpecProject,
} from "../openspec/model";
import { readTasks } from "../openspec/tasks";
import { scanWorkspace } from "../openspec/scanner";
import { validateChange, ValidationResult } from "../openspec/validate";

/** Filtro aplicado a la lista de cambios activos. */
export type ChangeFilter = "all" | "pending" | "completed";

/** Tipos de nodo que puede contener el árbol. */
type NodeKind =
  | "project"
  | "category"
  | "change"
  | "artifact"
  | "tasksGroup"
  | "taskSection"
  | "task"
  | "spec";

/** Nodo genérico del árbol. Se usa una unión laxa por comodidad. */
export interface OSNode {
  kind: NodeKind;
  label: string;
  description?: string;
  /** Payload según el tipo de nodo. */
  project?: OpenSpecProject;
  change?: Change;
  artifact?: ArtifactFile;
  spec?: ActiveSpec;
  /** Para categorías: identificador lógico. */
  category?: "changes" | "specs" | "archive" | "config";
  /** Para nodos de tarea. */
  taskFsPath?: string;
  taskLine?: number;
  taskDone?: boolean;
  /** Hijos precalculados (secciones/tareas). */
  children?: OSNode[];
  /** Para la categoría de cambios: true si hay filtro/búsqueda activos. */
  filterActive?: boolean;
}

export class OpenSpecTreeProvider
  implements vscode.TreeDataProvider<OSNode>
{
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<
    OSNode | undefined | void
  >();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private projects: OpenSpecProject[] = [];
  /** Resultados de validación por dirPath del cambio. */
  private validation = new Map<string, ValidationResult>();
  /** Filtro actual de cambios activos. */
  private filter: ChangeFilter = "all";
  /** Texto de búsqueda (subcadena en el id del cambio). */
  private query = "";

  /** Callback opcional para volcar los issues a diagnósticos (Problems). */
  onValidated?: (
    results: Map<string, ValidationResult>,
    changes: Change[]
  ) => void;

  refresh(): void {
    this.projects = scanWorkspace();
    // Expone si hay proyectos para el viewsWelcome / context keys.
    vscode.commands.executeCommand(
      "setContext",
      "openspec.hasProjects",
      this.projects.length > 0
    );
    this._onDidChangeTreeData.fire();
    void this.runValidationPass();
  }

  getProjects(): OpenSpecProject[] {
    return this.projects;
  }

  setFilter(filter: ChangeFilter): void {
    this.filter = filter;
    vscode.commands.executeCommand("setContext", "openspec.filter", filter);
    this._onDidChangeTreeData.fire();
  }

  getFilter(): ChangeFilter {
    return this.filter;
  }

  getQuery(): string {
    return this.query;
  }

  setQuery(query: string): void {
    this.query = query.trim().toLowerCase();
    this._onDidChangeTreeData.fire();
  }

  /** Restaura filtro y búsqueda a su estado inicial. */
  clearFilter(): void {
    this.filter = "all";
    this.query = "";
    vscode.commands.executeCommand("setContext", "openspec.filter", "all");
    this._onDidChangeTreeData.fire();
  }

  /** Aplica filtro y búsqueda a una lista de cambios activos. */
  private applyFilter(changes: Change[]): Change[] {
    return changes.filter((c) => {
      if (this.query && !c.id.toLowerCase().includes(this.query)) {
        return false;
      }
      const stats = c.taskStats;
      const complete = !!stats && stats.total > 0 && stats.done === stats.total;
      if (this.filter === "pending") {
        return !complete;
      }
      if (this.filter === "completed") {
        return complete;
      }
      return true;
    });
  }

  /** Valida todos los cambios activos y refresca el árbol al terminar. */
  private async runValidationPass(): Promise<void> {
    const changes: Change[] = [];
    for (const p of this.projects) {
      changes.push(...p.activeChanges);
    }
    let anyChange = false;
    for (const change of changes) {
      const result = await validateChange(change);
      const prev = this.validation.get(change.dirPath);
      if (!prev || prev.status !== result.status) {
        anyChange = true;
      }
      this.validation.set(change.dirPath, result);
    }
    if (this.onValidated) {
      this.onValidated(this.validation, changes);
    }
    if (anyChange) {
      this._onDidChangeTreeData.fire();
    }
  }

  getTreeItem(node: OSNode): vscode.TreeItem {
    switch (node.kind) {
      case "project":
        return this.projectItem(node);
      case "category":
        return this.categoryItem(node);
      case "change":
        return this.changeItem(node);
      case "artifact":
        return this.artifactItem(node);
      case "tasksGroup":
        return this.tasksGroupItem(node);
      case "taskSection":
        return this.sectionItem(node);
      case "task":
        return this.taskItem(node);
      case "spec":
        return this.specItem(node);
    }
  }

  getChildren(node?: OSNode): OSNode[] {
    if (!node) {
      return this.rootChildren();
    }
    switch (node.kind) {
      case "project":
        return this.projectChildren(node.project!);
      case "category":
        return this.categoryChildren(node);
      case "change":
        return this.changeChildren(node.change!);
      case "tasksGroup":
        return node.children ?? [];
      case "taskSection":
        return node.children ?? [];
      default:
        return [];
    }
  }

  // ---------- Construcción de hijos ----------

  private rootChildren(): OSNode[] {
    if (this.projects.length === 0) {
      return [];
    }
    // Con un solo proyecto mostramos directamente las categorías.
    if (this.projects.length === 1) {
      return this.projectChildren(this.projects[0]);
    }
    return this.projects.map((p) => ({
      kind: "project",
      label: p.name,
      description: this.projectSummary(p),
      project: p,
    }));
  }

  private projectChildren(project: OpenSpecProject): OSNode[] {
    const nodes: OSNode[] = [];
    if (project.configPath) {
      nodes.push({
        kind: "artifact",
        label: "config.yaml",
        artifact: {
          label: "config.yaml",
          kind: "generic",
          fsPath: project.configPath,
        },
      });
    }
    // Refleja el estado de filtro/búsqueda en la categoría de cambios activos.
    const filtered = this.applyFilter(project.activeChanges).length;
    const total = project.activeChanges.length;
    const active = this.filter !== "all" || this.query.length > 0;
    let changesDesc = active ? `${filtered}/${total}` : `${total}`;
    const badges: string[] = [];
    if (this.filter === "pending") badges.push(vscode.l10n.t("pending"));
    if (this.filter === "completed") badges.push(vscode.l10n.t("completed"));
    if (this.query) badges.push(`"${this.query}"`);
    if (badges.length > 0) {
      changesDesc += ` · ${badges.join(" · ")}`;
    }
    nodes.push({
      kind: "category",
      label: vscode.l10n.t("Active changes"),
      description: changesDesc,
      category: "changes",
      project,
      // contextValue con sufijo para mostrar el botón "limpiar filtro" cuando aplica.
      filterActive: active,
    });
    nodes.push({
      kind: "category",
      label: vscode.l10n.t("Active specs"),
      description: `${project.activeSpecs.length}`,
      category: "specs",
      project,
    });
    nodes.push({
      kind: "category",
      label: vscode.l10n.t("Archived"),
      description: `${project.archivedChanges.length}`,
      category: "archive",
      project,
    });
    return nodes;
  }

  private categoryChildren(node: OSNode): OSNode[] {
    const project = node.project!;
    if (node.category === "changes") {
      return this.applyFilter(project.activeChanges).map((c) =>
        this.changeNode(c)
      );
    }
    if (node.category === "archive") {
      return project.archivedChanges.map((c) => this.changeNode(c));
    }
    if (node.category === "specs") {
      return project.activeSpecs.map((s) => ({
        kind: "spec",
        label: s.capability,
        spec: s,
      }));
    }
    return [];
  }

  private changeNode(change: Change): OSNode {
    let description: string | undefined;
    if (change.taskStats && change.taskStats.total > 0) {
      const { done, total } = change.taskStats;
      // % al inicio para lectura rápida del avance.
      description = `${pctText(done, total)} · ${done}/${total}`;
    }
    return { kind: "change", label: change.id, description, change };
  }

  private changeChildren(change: Change): OSNode[] {
    const nodes: OSNode[] = [];
    for (const art of change.artifacts) {
      if (art.kind === "tasks") {
        nodes.push(this.buildTasksGroup(change));
      } else {
        nodes.push({ kind: "artifact", label: art.label, artifact: art });
      }
    }
    for (const delta of change.specDeltas) {
      nodes.push({
        kind: "artifact",
        label: `spec: ${delta.label}`,
        artifact: delta,
      });
    }
    return nodes;
  }

  private buildTasksGroup(change: Change): OSNode {
    const sections = readTasks(change.tasksPath!);
    const sectionNodes: OSNode[] = sections.map((section) => {
      const done = section.tasks.filter((t) => t.done).length;
      const total = section.tasks.length;
      return {
        kind: "taskSection",
        label: section.title,
        // % al inicio de cada sección (subtareas).
        description: `${pctText(done, total)} · ${done}/${total}`,
        children: section.tasks.map((task) => ({
          kind: "task",
          label: task.text,
          taskFsPath: change.tasksPath!,
          taskLine: task.line,
          taskDone: task.done,
        })),
      };
    });
    let description: string | undefined;
    if (change.taskStats) {
      const { done, total } = change.taskStats;
      // % al inicio del grupo "Tareas".
      description = `${pctText(done, total)} · ${done}/${total}`;
    }
    return {
      kind: "tasksGroup",
      label: vscode.l10n.t("Tasks"),
      description,
      artifact: change.artifacts.find((a) => a.kind === "tasks"),
      children: sectionNodes,
    };
  }

  // ---------- TreeItems ----------

  private projectItem(node: OSNode): vscode.TreeItem {
    const item = new vscode.TreeItem(
      node.label,
      vscode.TreeItemCollapsibleState.Expanded
    );
    item.description = node.description;
    item.iconPath = new vscode.ThemeIcon("repo");
    item.contextValue = "project";
    return item;
  }

  private categoryItem(node: OSNode): vscode.TreeItem {
    const iconMap: Record<string, string> = {
      changes: "git-pull-request",
      specs: "book",
      archive: "archive",
    };
    const collapsed =
      node.category === "changes"
        ? vscode.TreeItemCollapsibleState.Expanded
        : vscode.TreeItemCollapsibleState.Collapsed;
    const item = new vscode.TreeItem(node.label, collapsed);
    item.description = node.description;
    item.iconPath = new vscode.ThemeIcon(iconMap[node.category ?? "changes"]);
    // Sufijo -filtered para mostrar el botón inline "limpiar filtro".
    item.contextValue =
      node.category === "changes" && node.filterActive
        ? "category-changes-filtered"
        : `category-${node.category}`;
    return item;
  }

  private changeItem(node: OSNode): vscode.TreeItem {
    const change = node.change!;
    const item = new vscode.TreeItem(
      node.label,
      vscode.TreeItemCollapsibleState.Collapsed
    );
    item.description = node.description;

    const stats = change.taskStats;
    const hasTasks = !!stats && stats.total > 0;
    const allDone = hasTasks && stats!.done === stats!.total;
    const hasPending = hasTasks && stats!.done < stats!.total;

    // El contextValue define qué botón inline aparece (play / archive).
    if (change.archived) {
      item.contextValue = "change-archived";
    } else if (hasPending) {
      item.contextValue = "change-runnable";
    } else {
      // Completado o sin tareas: listo para archivar.
      item.contextValue = "change-archivable";
    }

    // Estado de validación: si es inválido, prima el icono de advertencia.
    const validation = this.validation.get(change.dirPath);
    if (!change.archived && validation?.status === "invalid") {
      item.iconPath = new vscode.ThemeIcon(
        "warning",
        new vscode.ThemeColor("list.warningForeground")
      );
      item.tooltip = new vscode.MarkdownString(
        `**${vscode.l10n.t("Invalid change")}**\n\n` +
          validation.messages.map((m) => `- ${m}`).join("\n")
      );
    } else {
      item.iconPath = new vscode.ThemeIcon(
        allDone || (!hasTasks && !change.archived)
          ? "pass-filled"
          : change.archived
            ? "archive"
            : "circle-large-outline"
      );
      item.tooltip = change.dirPath;
    }
    return item;
  }

  private artifactItem(node: OSNode): vscode.TreeItem {
    const item = new vscode.TreeItem(
      node.label,
      vscode.TreeItemCollapsibleState.None
    );
    const iconMap: Record<string, string> = {
      proposal: "lightbulb",
      design: "circuit-board",
      tasks: "checklist",
      spec: "book",
      generic: "gear",
    };
    item.iconPath = new vscode.ThemeIcon(
      iconMap[node.artifact?.kind ?? "generic"]
    );
    // Los spec deltas llevan un contextValue propio para habilitar "Ver impacto".
    item.contextValue =
      node.artifact?.kind === "spec" ? "file-spec-delta" : "file";
    // Click abre el preview.
    item.command = {
      command: "openspec.preview",
      title: "Preview",
      arguments: [node],
    };
    item.tooltip = node.artifact?.fsPath;
    return item;
  }

  private tasksGroupItem(node: OSNode): vscode.TreeItem {
    const item = new vscode.TreeItem(
      node.label,
      vscode.TreeItemCollapsibleState.Expanded
    );
    item.description = node.description;
    item.iconPath = new vscode.ThemeIcon("checklist");
    item.contextValue = "file";
    item.command = {
      command: "openspec.preview",
      title: "Preview",
      arguments: [node],
    };
    return item;
  }

  private sectionItem(node: OSNode): vscode.TreeItem {
    const item = new vscode.TreeItem(
      node.label,
      vscode.TreeItemCollapsibleState.Expanded
    );
    item.description = node.description;
    item.iconPath = new vscode.ThemeIcon("list-unordered");
    item.contextValue = "taskSection";
    return item;
  }

  private taskItem(node: OSNode): vscode.TreeItem {
    const item = new vscode.TreeItem(
      node.label,
      vscode.TreeItemCollapsibleState.None
    );
    // Checkbox nativo interactivo (VSCode >= 1.72).
    item.checkboxState = node.taskDone
      ? vscode.TreeItemCheckboxState.Checked
      : vscode.TreeItemCheckboxState.Unchecked;
    item.contextValue = "task";
    // Doble clic (detectado en el handler) abre el tasks.md en la línea de la tarea.
    item.command = {
      command: "openspec.taskClick",
      title: vscode.l10n.t("Go to task"),
      arguments: [node.taskFsPath, node.taskLine],
    };
    item.tooltip = vscode.l10n.t("Double-click to open tasks.md at this task");
    return item;
  }

  private specItem(node: OSNode): vscode.TreeItem {
    const item = new vscode.TreeItem(
      node.label,
      vscode.TreeItemCollapsibleState.None
    );
    item.iconPath = new vscode.ThemeIcon("book");
    // 'file-spec-active' habilita preview/openSource (=~ /^file/) y además "Cerrar spec".
    item.contextValue = "file-spec-active";
    item.command = {
      command: "openspec.preview",
      title: "Preview",
      arguments: [
        {
          kind: "spec",
          label: node.label,
          artifact: {
            label: node.spec!.capability,
            kind: "spec",
            fsPath: node.spec!.fsPath,
          },
        } as OSNode,
      ],
    };
    item.tooltip = node.spec?.fsPath;
    return item;
  }

  private projectSummary(p: OpenSpecProject): string {
    return vscode.l10n.t(
      "{0} changes · {1} specs",
      p.activeChanges.length,
      p.activeSpecs.length
    );
  }
}

/** Formatea el porcentaje de avance; devuelve "0%" si no hay tareas. */
function pctText(done: number, total: number): string {
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;
  return `${pct}%`;
}
