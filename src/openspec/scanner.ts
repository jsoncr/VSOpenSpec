// Detección y parseo de proyectos OpenSpec dentro del workspace.
import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import {
  ActiveSpec,
  ArtifactFile,
  Change,
  OpenSpecProject,
} from "./model";
import { computeStats, readTasks } from "./tasks";

/** Nombres de carpetas que nunca vale la pena recorrer al buscar openspec/. */
const IGNORED_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  "out",
  ".dart_tool",
  "target",
  ".venv",
  "vendor",
]);

/** Devuelve true si la ruta es un directorio existente. */
function isDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** Devuelve true si la ruta es un archivo existente. */
function isFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

/** Busca recursivamente carpetas 'openspec' con un límite de profundidad. */
function findOpenSpecDirs(root: string, depth: number, acc: string[]): void {
  if (depth < 0) {
    return;
  }
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    if (entry.name === "openspec") {
      acc.push(path.join(root, entry.name));
      continue; // no seguimos descendiendo dentro de openspec/
    }
    if (IGNORED_DIRS.has(entry.name) || entry.name.startsWith(".")) {
      continue;
    }
    findOpenSpecDirs(path.join(root, entry.name), depth - 1, acc);
  }
}

/** Construye la lista de artefactos principales de un cambio. */
function readChangeArtifacts(changeDir: string): ArtifactFile[] {
  const artifacts: ArtifactFile[] = [];
  const known: Array<[string, ArtifactFile["kind"], string]> = [
    ["proposal.md", "proposal", vscode.l10n.t("Proposal")],
    ["design.md", "design", vscode.l10n.t("Design")],
    ["tasks.md", "tasks", vscode.l10n.t("Tasks")],
  ];
  for (const [file, kind, label] of known) {
    const full = path.join(changeDir, file);
    if (isFile(full)) {
      artifacts.push({ label, kind, fsPath: full });
    }
  }
  return artifacts;
}

/** Lee los spec deltas de un cambio (changes/<id>/specs/<cap>/spec.md). */
function readSpecDeltas(changeDir: string): ArtifactFile[] {
  const specsDir = path.join(changeDir, "specs");
  const deltas: ArtifactFile[] = [];
  if (!isDir(specsDir)) {
    return deltas;
  }
  for (const cap of fs.readdirSync(specsDir)) {
    const specFile = path.join(specsDir, cap, "spec.md");
    if (isFile(specFile)) {
      deltas.push({ label: cap, kind: "spec", fsPath: specFile });
    }
  }
  return deltas;
}

/** Devuelve el mtime (ms) de un archivo/carpeta, o undefined si no existe. */
function mtimeMs(p: string): number | undefined {
  try {
    return fs.statSync(p).mtimeMs;
  } catch {
    return undefined;
  }
}

/** Devuelve la fecha de creación (ms) de una carpeta (birthtime, con fallback a ctime). */
function dirBirthtimeMs(p: string): number | undefined {
  try {
    const s = fs.statSync(p);
    return s.birthtimeMs || s.ctimeMs;
  } catch {
    return undefined;
  }
}

/** Lee el campo `created: YYYY-MM-DD` de .openspec.yaml y lo convierte a ms epoch. */
function readCreatedFromYaml(changeDir: string): number | undefined {
  try {
    const yaml = fs.readFileSync(path.join(changeDir, ".openspec.yaml"), "utf8");
    const m = yaml.match(/^\s*created:\s*['"]?(\d{4})-(\d{2})-(\d{2})/m);
    if (m) {
      // Construimos la fecha en horario LOCAL (no UTC) para que coincida con el
      // formateo local del dashboard y no se corra un día en zonas UTC-negativas.
      const [, y, mo, d] = m;
      const t = new Date(Number(y), Number(mo) - 1, Number(d)).getTime();
      return Number.isNaN(t) ? undefined : t;
    }
  } catch {
    // sin .openspec.yaml o sin campo created
  }
  return undefined;
}

/** Parsea un único cambio a partir de su carpeta. */
function readChange(changeDir: string, archived: boolean): Change {
  const artifacts = readChangeArtifacts(changeDir);
  const specDeltas = readSpecDeltas(changeDir);
  const tasksArtifact = artifacts.find((a) => a.kind === "tasks");

  const change: Change = {
    id: path.basename(changeDir),
    dirPath: changeDir,
    archived,
    artifacts,
    specDeltas,
  };

  if (tasksArtifact) {
    change.tasksPath = tasksArtifact.fsPath;
    change.taskStats = computeStats(readTasks(tasksArtifact.fsPath));
  }

  // Metadatos de tiempo para el dashboard.
  const files = [...artifacts, ...specDeltas].map((a) => a.fsPath);
  files.push(path.join(changeDir, ".openspec.yaml"));
  let updatedAt: number | undefined;
  for (const f of files) {
    const m = mtimeMs(f);
    if (m !== undefined) {
      updatedAt = updatedAt === undefined ? m : Math.max(updatedAt, m);
    }
  }
  change.updatedAt = updatedAt;
  change.createdAt = readCreatedFromYaml(changeDir) ?? dirBirthtimeMs(changeDir);
  // Al archivar, la carpeta se mueve: su mtime aproxima la fecha de archivado.
  change.archivedAt = archived ? mtimeMs(changeDir) : undefined;

  return change;
}

/** Lee todos los cambios dentro de un directorio (activos o archive). */
function readChanges(dir: string, archived: boolean): Change[] {
  if (!isDir(dir)) {
    return [];
  }
  const changes: Change[] = [];
  for (const name of fs.readdirSync(dir)) {
    if (name === "archive") {
      continue; // se procesa por separado
    }
    const full = path.join(dir, name);
    if (isDir(full)) {
      changes.push(readChange(full, archived));
    }
  }
  return changes.sort((a, b) => a.id.localeCompare(b.id));
}

/** Lee las specs activas (openspec/specs/<capability>/spec.md). */
function readActiveSpecs(specsDir: string): ActiveSpec[] {
  if (!isDir(specsDir)) {
    return [];
  }
  const specs: ActiveSpec[] = [];
  for (const cap of fs.readdirSync(specsDir)) {
    const specFile = path.join(specsDir, cap, "spec.md");
    if (isFile(specFile)) {
      specs.push({ capability: cap, fsPath: specFile });
    }
  }
  return specs.sort((a, b) => a.capability.localeCompare(b.capability));
}

/** Parsea un proyecto OpenSpec completo a partir de su carpeta openspec/. */
function readProject(openspecDir: string): OpenSpecProject {
  const parent = path.dirname(openspecDir);
  const configPath = path.join(openspecDir, "config.yaml");
  const changesDir = path.join(openspecDir, "changes");

  return {
    name: path.basename(parent),
    rootPath: openspecDir,
    configPath: isFile(configPath) ? configPath : undefined,
    activeChanges: readChanges(changesDir, false),
    archivedChanges: readChanges(path.join(changesDir, "archive"), true),
    activeSpecs: readActiveSpecs(path.join(openspecDir, "specs")),
  };
}

/** Escanea todas las carpetas del workspace en busca de proyectos OpenSpec. */
export function scanWorkspace(): OpenSpecProject[] {
  const folders = vscode.workspace.workspaceFolders ?? [];
  const dirs: string[] = [];
  for (const folder of folders) {
    const root = folder.uri.fsPath;
    // Detecta openspec/ en la raíz o hasta 3 niveles de anidamiento (monorepos).
    findOpenSpecDirs(root, 3, dirs);
  }
  // Deduplica por ruta.
  const unique = Array.from(new Set(dirs));
  return unique
    .map(readProject)
    .sort((a, b) => a.name.localeCompare(b.name));
}
