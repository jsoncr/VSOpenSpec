// Parseo y edición de tasks.md (checkboxes markdown).
import * as fs from "fs";
import * as vscode from "vscode";
import { TaskSection, TaskStats } from "./model";

// Detecta una línea de checkbox markdown: "- [ ] texto" o "- [x] texto".
const CHECKBOX_RE = /^(\s*[-*]\s+)\[( |x|X)\]\s?(.*)$/;
// Detecta un encabezado markdown: "## título".
const HEADING_RE = /^(#{1,6})\s+(.*)$/;

/** Divide el contenido en líneas preservando el índice original. */
function splitLines(content: string): string[] {
  return content.split(/\r?\n/);
}

/** Parsea el contenido de un tasks.md en secciones con sus tareas. */
export function parseTasks(content: string): TaskSection[] {
  const lines = splitLines(content);
  const sections: TaskSection[] = [];
  // Sección por defecto para tareas que aparecen antes de cualquier encabezado.
  let current: TaskSection = { title: vscode.l10n.t("Tasks"), tasks: [] };
  let currentUsed = false;

  lines.forEach((raw, index) => {
    const heading = raw.match(HEADING_RE);
    if (heading) {
      // Al encontrar un encabezado, cerramos la sección previa si tenía tareas.
      if (current.tasks.length > 0 || currentUsed) {
        if (current.tasks.length > 0) {
          sections.push(current);
        }
      }
      current = { title: heading[2].trim(), tasks: [] };
      currentUsed = true;
      return;
    }

    const cb = raw.match(CHECKBOX_RE);
    if (cb) {
      current.tasks.push({
        text: cb[3].trim(),
        done: cb[2].toLowerCase() === "x",
        line: index,
      });
    }
  });

  if (current.tasks.length > 0) {
    sections.push(current);
  }

  return sections;
}

/** Calcula el progreso total a partir de las secciones parseadas. */
export function computeStats(sections: TaskSection[]): TaskStats {
  let total = 0;
  let done = 0;
  for (const section of sections) {
    for (const task of section.tasks) {
      total += 1;
      if (task.done) {
        done += 1;
      }
    }
  }
  return { total, done };
}

/** Lee y parsea un tasks.md desde disco. Devuelve [] si no existe. */
export function readTasks(fsPath: string): TaskSection[] {
  try {
    const content = fs.readFileSync(fsPath, "utf8");
    return parseTasks(content);
  } catch {
    return [];
  }
}

/**
 * Alterna el checkbox de una línea concreta y reescribe el archivo.
 * Devuelve el nuevo estado (true = marcada) o null si la línea no era un checkbox.
 */
export function toggleTaskLine(fsPath: string, line: number): boolean | null {
  const content = fs.readFileSync(fsPath, "utf8");
  const lines = splitLines(content);
  if (line < 0 || line >= lines.length) {
    return null;
  }
  const match = lines[line].match(CHECKBOX_RE);
  if (!match) {
    return null;
  }
  const nowDone = match[2].toLowerCase() !== "x";
  const newMark = nowDone ? "x" : " ";
  lines[line] = `${match[1]}[${newMark}] ${match[3]}`;
  fs.writeFileSync(fsPath, lines.join("\n"), "utf8");
  return nowDone;
}
