// Cálculo de métricas agregadas para el dashboard, a partir de los proyectos.
import { OpenSpecProject, Change } from "../openspec/model";
import { readTasks } from "../openspec/tasks";

const DAY_MS = 24 * 60 * 60 * 1000;

/** Resumen de progreso de una sección de tareas (para el mind map). */
export interface SectionSummary {
  title: string;
  done: number;
  total: number;
  pct: number;
}

/** Fila de un cambio con sus métricas listas para graficar. */
export interface ChangeRow {
  id: string;
  project: string;
  done: number;
  total: number;
  pct: number;
  createdAt?: number;
  updatedAt?: number;
  archivedAt?: number;
  /** Días entre creación y (archivado | última actividad | ahora). */
  durationDays?: number;
  /** Secciones de tareas (hojas del mind map). */
  sections: SectionSummary[];
}

/** Métricas de una sección (activos o archivados). */
export interface Section {
  changeCount: number;
  totalTasks: number;
  doneTasks: number;
  pendingTasks: number;
  pctComplete: number;
  /** Cambios con el 100% de tareas hechas. */
  completedChanges: number;
  rows: ChangeRow[];
  /** Histograma de progreso: [0%, 1-25, 26-50, 51-75, 76-99, 100%]. */
  progressBuckets: number[];
  /** Promedio de durationDays (solo tiene sentido en archivados). */
  avgDurationDays?: number;
  /** Cambios por mes de creación: pares [YYYY-MM, count] ordenados. */
  byMonth: Array<[string, number]>;
  /** Velocidad: tareas completadas por semana [YYYY-MM-DD lunes, count]. */
  velocity: Array<[string, number]>;
}

export interface Analytics {
  generatedAt: number;
  active: Section;
  archived: Section;
}

/** Índice de bucket de progreso para un porcentaje dado. */
function bucketIndex(pct: number): number {
  if (pct <= 0) return 0;
  if (pct <= 25) return 1;
  if (pct <= 50) return 2;
  if (pct <= 75) return 3;
  if (pct < 100) return 4;
  return 5;
}

/** Formatea un ms epoch a "YYYY-MM". */
function monthKey(ms: number): string {
  const d = new Date(ms);
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  return `${d.getFullYear()}-${mm}`;
}

/** Devuelve el lunes de la semana de una fecha, como "YYYY-MM-DD" (local). */
function weekKey(ms: number): string {
  const d = new Date(ms);
  const day = (d.getDay() + 6) % 7; // 0 = lunes
  const monday = new Date(d.getFullYear(), d.getMonth(), d.getDate() - day);
  const mm = String(monday.getMonth() + 1).padStart(2, "0");
  const dd = String(monday.getDate()).padStart(2, "0");
  return `${monday.getFullYear()}-${mm}-${dd}`;
}

/** Construye una fila a partir de un cambio. */
function toRow(change: Change, projectName: string, now: number): ChangeRow {
  const done = change.taskStats?.done ?? 0;
  const total = change.taskStats?.total ?? 0;
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;

  // Fin del intervalo: archivado, si no última actividad, si no "ahora".
  const end = change.archivedAt ?? change.updatedAt ?? now;
  let durationDays: number | undefined;
  if (change.createdAt !== undefined) {
    durationDays = Math.max(0, Math.round((end - change.createdAt) / DAY_MS));
  }

  // Secciones de tareas (para el mind map). Solo si hay tasks.md.
  const sections: SectionSummary[] = [];
  if (change.tasksPath) {
    for (const sec of readTasks(change.tasksPath)) {
      const secDone = sec.tasks.filter((t) => t.done).length;
      const secTotal = sec.tasks.length;
      sections.push({
        title: sec.title,
        done: secDone,
        total: secTotal,
        pct: secTotal > 0 ? Math.round((secDone / secTotal) * 100) : 0,
      });
    }
  }

  return {
    id: change.id,
    project: projectName,
    done,
    total,
    pct,
    createdAt: change.createdAt,
    updatedAt: change.updatedAt,
    archivedAt: change.archivedAt,
    durationDays,
    sections,
  };
}

/** Agrega una sección a partir de un conjunto de filas. */
function buildSection(rows: ChangeRow[]): Section {
  let totalTasks = 0;
  let doneTasks = 0;
  let completedChanges = 0;
  const progressBuckets = [0, 0, 0, 0, 0, 0];
  const monthMap = new Map<string, number>();
  const durations: number[] = [];

  for (const r of rows) {
    totalTasks += r.total;
    doneTasks += r.done;
    if (r.total > 0 && r.done === r.total) {
      completedChanges += 1;
    }
    progressBuckets[bucketIndex(r.pct)] += 1;
    if (r.createdAt !== undefined) {
      const key = monthKey(r.createdAt);
      monthMap.set(key, (monthMap.get(key) ?? 0) + 1);
    }
    if (r.durationDays !== undefined) {
      durations.push(r.durationDays);
    }
  }

  const pctComplete =
    totalTasks > 0 ? Math.round((doneTasks / totalTasks) * 100) : 0;
  const avgDurationDays =
    durations.length > 0
      ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length)
      : undefined;

  const byMonth = Array.from(monthMap.entries()).sort((a, b) =>
    a[0].localeCompare(b[0])
  );

  // Velocidad: aproximamos "tareas completadas" por semana usando la última
  // actividad (updatedAt) del cambio y su nº de tareas hechas. Es un proxy: no
  // hay historial por tarea, pero refleja el ritmo de cierre reciente.
  const weekMap = new Map<string, number>();
  for (const r of rows) {
    if (r.done > 0 && r.updatedAt !== undefined) {
      const key = weekKey(r.updatedAt);
      weekMap.set(key, (weekMap.get(key) ?? 0) + r.done);
    }
  }
  const velocity = Array.from(weekMap.entries()).sort((a, b) =>
    a[0].localeCompare(b[0])
  );

  return {
    changeCount: rows.length,
    totalTasks,
    doneTasks,
    pendingTasks: totalTasks - doneTasks,
    pctComplete,
    completedChanges,
    rows,
    progressBuckets,
    avgDurationDays,
    byMonth,
    velocity,
  };
}

/** Calcula todas las métricas del dashboard. `now` es ms epoch (inyectado). */
export function computeAnalytics(
  projects: OpenSpecProject[],
  now: number
): Analytics {
  const activeRows: ChangeRow[] = [];
  const archivedRows: ChangeRow[] = [];

  for (const p of projects) {
    for (const c of p.activeChanges) {
      activeRows.push(toRow(c, p.name, now));
    }
    for (const c of p.archivedChanges) {
      archivedRows.push(toRow(c, p.name, now));
    }
  }

  // Activos: por progreso descendente. Archivados: por fecha de archivado desc.
  activeRows.sort((a, b) => b.pct - a.pct || a.id.localeCompare(b.id));
  archivedRows.sort(
    (a, b) => (b.archivedAt ?? 0) - (a.archivedAt ?? 0) || a.id.localeCompare(b.id)
  );

  return {
    generatedAt: now,
    active: buildSection(activeRows),
    archived: buildSection(archivedRows),
  };
}
