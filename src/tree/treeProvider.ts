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
}

export class OpenSpecTreeProvider
  implements vscode.TreeDataProvider<OSNode>
{
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<
    OSNode | undefined | void
  >();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private projects: OpenSpecProject[] = [];

  refresh(): void {
    this.projects = scanWorkspace();
    // Expone si hay proyectos para el viewsWelcome / context keys.
    vscode.commands.executeCommand(
      "setContext",
      "openspec.hasProjects",
      this.projects.length > 0
    );
    this._onDidChangeTreeData.fire();
  }

  getProjects(): OpenSpecProject[] {
    return this.projects;
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
    nodes.push({
      kind: "category",
      label: "Cambios activos",
      description: `${project.activeChanges.length}`,
      category: "changes",
      project,
    });
    nodes.push({
      kind: "category",
      label: "Specs activas",
      description: `${project.activeSpecs.length}`,
      category: "specs",
      project,
    });
    nodes.push({
      kind: "category",
      label: "Archivados",
      description: `${project.archivedChanges.length}`,
      category: "archive",
      project,
    });
    return nodes;
  }

  private categoryChildren(node: OSNode): OSNode[] {
    const project = node.project!;
    if (node.category === "changes") {
      return project.activeChanges.map((c) => this.changeNode(c));
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
      label: "Tareas",
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
    item.contextValue = `category-${node.category}`;
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

    item.iconPath = new vscode.ThemeIcon(
      allDone || (!hasTasks && !change.archived)
        ? "pass-filled"
        : change.archived
          ? "archive"
          : "circle-large-outline"
    );
    item.tooltip = change.dirPath;
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
    item.contextValue = "file";
    // Click abre el preview.
    item.command = {
      command: "openspec.preview",
      title: "Previsualizar",
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
      title: "Previsualizar",
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
      title: "Ir a la tarea",
      arguments: [node.taskFsPath, node.taskLine],
    };
    item.tooltip = "Doble clic para abrir el tasks.md en esta tarea";
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
      title: "Previsualizar",
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
    return `${p.activeChanges.length} cambios · ${p.activeSpecs.length} specs`;
  }
}

/** Formatea el porcentaje de avance; devuelve "0%" si no hay tareas. */
function pctText(done: number, total: number): string {
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;
  return `${pct}%`;
}
