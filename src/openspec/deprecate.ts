// Generación de un change de deprecación para cerrar una spec activa.
import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import { ActiveSpec } from "./model";

/** Deriva la ruta de la carpeta openspec/ a partir de la ruta de una spec. */
function resolveOpenSpecRoot(specFsPath: string): string {
  const marker = `${path.sep}openspec${path.sep}`;
  const idx = specFsPath.indexOf(marker);
  if (idx < 0) {
    // Fallback: subimos dos niveles (specs/<cap>/spec.md -> specs -> openspec).
    return path.dirname(path.dirname(path.dirname(specFsPath)));
  }
  return specFsPath.substring(0, idx) + path.sep + "openspec";
}

/**
 * Extrae los bloques "### Requirement: ..." (con sus escenarios) del contenido
 * de una spec activa, para reproducirlos bajo "## REMOVED Requirements".
 */
function extractRequirementBlocks(content: string): string[] {
  const lines = content.split(/\r?\n/);
  const blocks: string[] = [];
  let current: string[] | null = null;

  for (const line of lines) {
    if (/^###\s+Requirement:/.test(line)) {
      if (current) {
        blocks.push(current.join("\n").trimEnd());
      }
      current = [line];
    } else if (/^##\s+/.test(line)) {
      // Nuevo encabezado H2: cierra el requirement en curso.
      if (current) {
        blocks.push(current.join("\n").trimEnd());
        current = null;
      }
    } else if (current) {
      current.push(line);
    }
  }
  if (current) {
    blocks.push(current.join("\n").trimEnd());
  }
  return blocks;
}

/** Genera un id de change único (deprecate-<cap>, -2, -3, ...). */
function uniqueChangeId(changesDir: string, base: string): string {
  let id = base;
  let n = 2;
  while (fs.existsSync(path.join(changesDir, id))) {
    id = `${base}-${n}`;
    n += 1;
  }
  return id;
}

export interface DeprecationResult {
  changeId: string;
  changeDir: string;
  proposalPath: string;
}

/**
 * Crea un change de deprecación para la spec dada:
 *  - changes/deprecate-<cap>/proposal.md
 *  - changes/deprecate-<cap>/tasks.md
 *  - changes/deprecate-<cap>/specs/<cap>/spec.md  (delta REMOVED)
 * No borra la spec: eso ocurre al archivar el change.
 */
export function createDeprecationChange(spec: ActiveSpec): DeprecationResult {
  const cap = spec.capability;
  const openspecRoot = resolveOpenSpecRoot(spec.fsPath);
  const changesDir = path.join(openspecRoot, "changes");
  const changeId = uniqueChangeId(changesDir, `deprecate-${cap}`);
  const changeDir = path.join(changesDir, changeId);
  const specDeltaDir = path.join(changeDir, "specs", cap);

  fs.mkdirSync(specDeltaDir, { recursive: true });

  // Delta REMOVED reproduciendo los requirements de la spec activa.
  let requirements: string[] = [];
  try {
    requirements = extractRequirementBlocks(
      fs.readFileSync(spec.fsPath, "utf8")
    );
  } catch {
    requirements = [];
  }

  // Los documentos generados son contenido del proyecto: los emitimos en el
  // idioma de la interfaz de VS Code (inglés por defecto, español si aplica).
  const isEs = vscode.env.language.toLowerCase().startsWith("es");

  const removedBody =
    requirements.length > 0
      ? requirements.join("\n\n")
      : isEs
        ? `### Requirement: ${cap}\nSe elimina la capability \`${cap}\` del sistema.`
        : `### Requirement: ${cap}\nThe \`${cap}\` capability is removed from the system.`;

  const specDelta = `## REMOVED Requirements\n\n${removedBody}\n`;
  fs.writeFileSync(path.join(specDeltaDir, "spec.md"), specDelta, "utf8");

  // Propuesta.
  const proposal = isEs
    ? `## Why

Se deprecia la capability \`${cap}\`. Deja de formar parte del alcance vigente del
sistema, por lo que debe retirarse de las specs activas para que la documentación
refleje el estado real.

## What Changes

- Eliminar la spec \`${cap}\` de \`openspec/specs/\` (delta REMOVED).
- Revisar y ajustar el código/documentación que dependa de esta capability.

## Impact

- La capability \`${cap}\` deja de estar activa al archivar este cambio.
- Verificar que ninguna otra spec o funcionalidad la requiera.
`
    : `## Why

The \`${cap}\` capability is being deprecated. It is no longer part of the system's
current scope, so it must be removed from the active specs for the documentation to
reflect the real state.

## What Changes

- Remove the \`${cap}\` spec from \`openspec/specs/\` (REMOVED delta).
- Review and adjust the code/documentation that depends on this capability.

## Impact

- The \`${cap}\` capability stops being active once this change is archived.
- Verify that no other spec or feature requires it.
`;
  const proposalPath = path.join(changeDir, "proposal.md");
  fs.writeFileSync(proposalPath, proposal, "utf8");

  // Tareas.
  const tasks = isEs
    ? `## 1. Deprecación de ${cap}

- [ ] 1.1 Confirmar que ningún código en producción depende de \`${cap}\`.
- [ ] 1.2 Verificar que ninguna otra spec activa referencie \`${cap}\`.
- [ ] 1.3 Actualizar documentación afectada.
- [ ] 1.4 Archivar este cambio (\`openspec archive ${changeId}\`) para remover la spec de \`openspec/specs/\`.
`
    : `## 1. Deprecation of ${cap}

- [ ] 1.1 Confirm that no production code depends on \`${cap}\`.
- [ ] 1.2 Verify that no other active spec references \`${cap}\`.
- [ ] 1.3 Update affected documentation.
- [ ] 1.4 Archive this change (\`openspec archive ${changeId}\`) to remove the spec from \`openspec/specs/\`.
`;
  fs.writeFileSync(path.join(changeDir, "tasks.md"), tasks, "utf8");

  return { changeId, changeDir, proposalPath };
}
