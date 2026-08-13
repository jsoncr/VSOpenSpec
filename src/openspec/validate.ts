// Validación de cambios usando la CLI de OpenSpec (openspec validate).
import { execFile } from "child_process";
import * as path from "path";
import { Change } from "./model";
import { openspecRootOf } from "./paths";

export type ValidationStatus = "valid" | "invalid" | "unknown";

/** Issue tal como lo devuelve `openspec validate --json`. */
export interface OpenSpecIssue {
  level?: string;
  /** Ruta relativa a la carpeta specs/ del cambio, p. ej. "cap/spec.md". */
  path?: string;
  message?: string;
}

export interface ValidationResult {
  status: ValidationStatus;
  /** Issues estructurados (para diagnósticos). */
  issues: OpenSpecIssue[];
  /** Mensajes ya formateados (para tooltips). */
  messages: string[];
}

/** Caché por changeId+mtime para evitar reejecutar la CLI innecesariamente. */
const cache = new Map<string, { key: string; result: ValidationResult }>();

/** Ejecuta `openspec validate <id> --json` en el cwd del proyecto. */
function runValidate(cwd: string, changeId: string): Promise<ValidationResult> {
  return new Promise((resolve) => {
    execFile(
      "openspec",
      ["validate", changeId, "--json"],
      { cwd, timeout: 15000 },
      (error, stdout, stderr) => {
        const out = `${stdout || ""}\n${stderr || ""}`;
        // Intentamos parsear JSON; si no, inferimos por el texto/código de salida.
        const parsed = tryParseJson(stdout);
        if (parsed) {
          resolve(parsed);
          return;
        }
        if (!error) {
          resolve({ status: "valid", issues: [], messages: [] });
          return;
        }
        // Error de ejecución (p. ej. openspec no instalado): estado desconocido.
        const messages = out
          .split(/\r?\n/)
          .map((l) => l.trim())
          .filter((l) => l.length > 0)
          .slice(0, 8);
        resolve({ status: "unknown", issues: [], messages });
      }
    );
  });
}

/**
 * Interpreta la salida JSON de `openspec validate <id> --json`.
 * Formato: { items: [{ id, valid, issues: [{level, path, message}] }] }.
 */
function tryParseJson(stdout: string): ValidationResult | undefined {
  // El JSON puede venir precedido de líneas de progreso; tomamos desde la 1ª "{".
  const start = stdout.indexOf("{");
  if (start < 0) {
    return undefined;
  }
  try {
    const data = JSON.parse(stdout.substring(start));
    const items = Array.isArray(data.items) ? data.items : [];
    if (items.length === 0) {
      return undefined;
    }
    const item = items[0];
    const issues: OpenSpecIssue[] = Array.isArray(item.issues)
      ? item.issues
      : [];
    const messages = issues.map((i) => {
      const level = i.level ? `[${i.level}] ` : "";
      const where = i.path ? `${i.path}: ` : "";
      return `${level}${where}${i.message ?? ""}`.trim();
    });
    return {
      status: item.valid === true ? "valid" : "invalid",
      issues,
      messages,
    };
  } catch {
    return undefined;
  }
}

/** Valida un cambio (con caché por mtime). Devuelve "unknown" si no se puede. */
export async function validateChange(change: Change): Promise<ValidationResult> {
  const root = openspecRootOf(change.dirPath);
  if (!root) {
    return { status: "unknown", issues: [], messages: [] };
  }
  const cwd = path.dirname(root); // carpeta del proyecto (padre de openspec/)
  const key = `${change.updatedAt ?? 0}`;
  const cached = cache.get(change.dirPath);
  if (cached && cached.key === key) {
    return cached.result;
  }
  try {
    const result = await runValidate(cwd, change.id);
    cache.set(change.dirPath, { key, result });
    return result;
  } catch {
    return { status: "unknown", issues: [], messages: [] };
  }
}

/** Limpia la caché de validación (p. ej. al refrescar manualmente). */
export function clearValidationCache(): void {
  cache.clear();
}
