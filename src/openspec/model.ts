// Tipos de dominio que describen un proyecto OpenSpec y sus artefactos.

/** Un archivo de artefacto (proposal.md, design.md, tasks.md, spec.md). */
export interface ArtifactFile {
  /** Etiqueta legible: "Propuesta", "Diseño", "Tareas", o el nombre de capacidad. */
  label: string;
  /** Ruta absoluta al archivo .md. */
  fsPath: string;
  /** Tipo de artefacto para decidir el modo de render en el preview. */
  kind: "proposal" | "design" | "tasks" | "spec" | "generic";
}

/** Una tarea individual dentro de tasks.md. */
export interface TaskItem {
  /** Texto de la tarea sin el prefijo de checkbox. */
  text: string;
  /** true si está marcada [x]. */
  done: boolean;
  /** Índice de línea (0-based) dentro del archivo, para poder reescribirla. */
  line: number;
}

/** Una sección de tareas (encabezado ## dentro de tasks.md). */
export interface TaskSection {
  title: string;
  tasks: TaskItem[];
}

/** Estadística agregada de progreso de tareas. */
export interface TaskStats {
  total: number;
  done: number;
}

/** Un cambio (change) propuesto o archivado. */
export interface Change {
  /** Identificador = nombre de la carpeta del cambio. */
  id: string;
  /** Ruta absoluta a la carpeta del cambio. */
  dirPath: string;
  /** true si vive dentro de changes/archive. */
  archived: boolean;
  /** Artefactos principales presentes (proposal/design/tasks). */
  artifacts: ArtifactFile[];
  /** Spec deltas del cambio (changes/<id>/specs/<cap>/spec.md). */
  specDeltas: ArtifactFile[];
  /** Ruta al tasks.md si existe. */
  tasksPath?: string;
  /** Progreso de tareas (undefined si no hay tasks.md). */
  taskStats?: TaskStats;
}

/** Una spec activa (openspec/specs/<capability>/spec.md). */
export interface ActiveSpec {
  capability: string;
  fsPath: string;
}

/** Un proyecto OpenSpec detectado en el workspace. */
export interface OpenSpecProject {
  /** Nombre legible (nombre de la carpeta que contiene openspec/). */
  name: string;
  /** Ruta absoluta a la carpeta openspec/. */
  rootPath: string;
  /** Ruta al config.yaml si existe. */
  configPath?: string;
  activeChanges: Change[];
  archivedChanges: Change[];
  activeSpecs: ActiveSpec[];
}
