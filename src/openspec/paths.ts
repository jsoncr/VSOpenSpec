// Utilidades de rutas para resolver relaciones entre deltas y specs activas.
import * as path from "path";

/** Deriva la carpeta openspec/ a partir de cualquier ruta dentro de ella. */
export function openspecRootOf(fsPath: string): string | undefined {
  const marker = `${path.sep}openspec${path.sep}`;
  const idx = fsPath.indexOf(marker);
  if (idx < 0) {
    return undefined;
  }
  return fsPath.substring(0, idx) + path.sep + "openspec";
}

/**
 * Dado un spec delta (changes/<id>/specs/<cap>/spec.md), devuelve la ruta de la
 * spec activa correspondiente (openspec/specs/<cap>/spec.md).
 */
export function activeSpecPathForDelta(deltaFsPath: string): string | undefined {
  const root = openspecRootOf(deltaFsPath);
  if (!root) {
    return undefined;
  }
  // La capability es el nombre de la carpeta que contiene el spec.md del delta.
  const cap = path.basename(path.dirname(deltaFsPath));
  return path.join(root, "specs", cap, "spec.md");
}

/** Extrae la capability de un delta o spec (nombre de carpeta contenedora). */
export function capabilityOf(specFsPath: string): string {
  return path.basename(path.dirname(specFsPath));
}
