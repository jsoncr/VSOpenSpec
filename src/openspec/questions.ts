// Detección y resolución de "preguntas abiertas" en proposal.md y design.md
// de los cambios activos.
//
// Convención soportada (subconjunto documentado, sin heurísticas sobre texto
// narrativo libre):
// - Secciones de encabezado de cualquier nivel, en dos modos:
//     · "questions": "Open Question(s)", "Unresolved Question(s)",
//       "Preguntas abiertas" — cuentan ítems de lista de CUALQUIER nivel con
//       pregunta explícita ("?" en el texto visible aunque siga contexto o
//       propuesta, o prefijo explícito) o checkbox sin marcar "[ ]" con texto.
//     · "decisions": "Pending Decision(s)", "Asuntos pendientes",
//       "Decisiones pendientes" — además cuentan ítems declarativos con
//       texto, salvo rótulos de agrupación que terminan en ":" sin
//       pregunta/prefijo/checkbox.
//   Se normalizan mayúsculas, acentos, énfasis y dos puntos finales, y se
//   aceptan ATX y Setext (mismos tokens). En ambos modos, párrafos y
//   encabezados subordinados solo cuentan si son preguntas ("?" o prefijo):
//   los declarativos sueltos sin marcador se ignoran igual que antes. Un
//   encabezado de nivel igual o menor cierra la sección; una subsección
//   estructural no cuenta por sí misma.
// - Fuera de esas secciones solo cuentan los prefijos explícitos
//   "Open Question:", "Pregunta abierta:", "Pending Decision:" y
//   "Asunto pendiente:" (admite negritas alrededor del prefijo), también en
//   ítems de listas anidadas.
// - "[x]" resuelve solo el propio ítem, sin suprimir preguntas hijas
//   independientes.
// - El texto visible se extrae de los hijos inline de markdown-it (texto,
//   código en línea, saltos y "alt" de imágenes): no contiene marcas de
//   formato ("**", backticks) ni destinos de enlaces, así que un "?" dentro
//   de una URL no convierte el texto en pregunta.
// - Una pregunta queda resuelta cuando el mismo bloque —o el bloque
//   inmediatamente asociado— contiene una cita o párrafo "Answer:" /
//   "Respuesta:" no vacío; frases informales tras el "?" ("Se propone…",
//   "Hoy solo…") son contexto, no resolución. insertQuestionAnswer() añade
//   exactamente ese formato.
import * as fs from "fs";
import MarkdownIt from "markdown-it";

// markdown-it solo se usa para aislar bloques Markdown (tokens con map de
// líneas): el contenido de fences y citas nunca se interpreta como pregunta.
const md = new MarkdownIt({ html: false, linkify: false });

/** Subconjunto de campos de los tokens inline que usamos. */
interface InlineChild {
  type: string;
  content: string;
}

/** Subconjunto de campos de los tokens de bloque de markdown-it que usamos. */
interface BlockToken {
  type: string;
  tag: string;
  map: [number, number] | null;
  level: number;
  content: string;
  children?: InlineChild[] | null;
}

/** Una pregunta abierta detectada en un artefacto. */
export interface OpenQuestion {
  /** Texto visible de la pregunta (sin marcador de lista ni checkbox). */
  text: string;
  /** Línea (0-based) donde empieza el bloque de la pregunta. */
  line: number;
  /** Línea exclusiva donde termina el bloque (posición de inserción). */
  blockEnd: number;
  /** Indentación para anidar la respuesta dentro del ítem (vacío a nivel tope). */
  indent: string;
  /** Texto fuente del bloque completo; permite detectar cambios antes de editar. */
  snapshot: string;
  /**
   * Índice de ocurrencia (0-based) entre todos los candidatos del archivo con
   * el mismo texto — resueltos o pendientes—. Estable para claves de borrador:
   * resolver una duplicada no cambia la ocurrencia de las demás; borrarla sí
   * (y el borrador huérfano se descarta, nunca se traspasa).
   */
  occurrence: number;
  /**
   * Título del grupo estructural más cercano — un subencabezado de la sección
   * o un rótulo de ítem que termina en ":"—, si existe. Solo metadato de
   * presentación: no forma parte de la identidad ni de las claves de borrador.
   */
  groupTitle?: string;
}

/** Inserción calculada para añadir una respuesta (edición de rango mínimo). */
export interface AnswerInsertion {
  line: number;
  character: number;
  text: string;
}

// Secciones que habilitan la detección, divididas por modo (ya normalizadas).
// "questions": solo ítems con pregunta explícita o checkbox pendiente.
// "decisions": además ítems declarativos, salvo rótulos que terminan en ":".
const QUESTION_SECTIONS = new Set([
  "open question",
  "open questions",
  "unresolved question",
  "unresolved questions",
  "preguntas abiertas",
]);

const DECISION_SECTIONS = new Set([
  "pending decision",
  "pending decisions",
  "asuntos pendientes",
  "decisiones pendientes",
]);

/** Modo de detección que impone la sección vigente. */
type SectionMode = "questions" | "decisions";

// Prefijos explícitos admitidos fuera de una sección de preguntas.
const QUESTION_PREFIXES = [
  "open question",
  "pregunta abierta",
  "pending decision",
  "asunto pendiente",
];

/** Normaliza texto plano: sin marcado de énfasis, minúsculas, sin acentos. */
function normalizeText(text: string): string {
  return text
    .replace(/[*_`~]/g, "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/** Devuelve el modo de la sección según su título, o null si no aplica. */
function matchSection(text: string): SectionMode | null {
  const name = normalizeText(text).replace(/[:\s]+$/, "");
  if (QUESTION_SECTIONS.has(name)) {
    return "questions";
  }
  if (DECISION_SECTIONS.has(name)) {
    return "decisions";
  }
  return null;
}

/** Devuelve true si el texto empieza por un prefijo explícito de pregunta. */
function hasQuestionPrefix(text: string): boolean {
  const n = normalizeText(text);
  return QUESTION_PREFIXES.some((p) => n.startsWith(`${p}:`));
}

/**
 * Devuelve true si el texto visible es una pregunta: lleva "?" en cualquier
 * posición (puede ir seguido de contexto o propuesta) o un prefijo explícito.
 */
function isQuestionText(text: string): boolean {
  return normalizeText(text).includes("?") || hasQuestionPrefix(text);
}

/** Quita el BOM inicial si existe (VS Code lo separa del texto del documento). */
function stripBom(content: string): string {
  return content.charCodeAt(0) === 0xfeff ? content.slice(1) : content;
}

/**
 * Texto visible de un token inline: contenido de texto y de código en línea,
 * saltos de línea como espacio y "alt" de imágenes. No contiene marcas de
 * formato ("**", backticks) ni destinos de enlaces: un "?" dentro de la URL
 * no forma parte del texto visible.
 */
function visibleText(inline: BlockToken | undefined): string {
  let out = "";
  for (const child of inline?.children ?? []) {
    if (child.type === "text" || child.type === "code_inline") {
      out += child.content;
    } else if (child.type === "softbreak" || child.type === "hardbreak") {
      out += " ";
    } else if (child.type === "image") {
      out += child.content;
    }
  }
  return out;
}

/**
 * Devuelve true si el texto es una respuesta "Answer:"/"Respuesta:" no vacía.
 * La etiqueta admite énfasis (p. ej. "**Answer:**"); el cuerpo NO se
 * normaliza: una respuesta de solo puntuación ("***", "`") sigue contando.
 */
function isAnswerText(text: string): boolean {
  const lead = text.trimStart().replace(/^[*_`~]+/, "");
  const m = lead.match(/^(answer|respuesta)\s*:/i);
  if (!m) {
    return false;
  }
  const body = lead
    .slice(m[0].length)
    .trimStart()
    .replace(/^[*_`~]+/, ""); // cierra el énfasis de la etiqueta
  return body.trim().length > 0;
}

/** Índice del token `list_item_close` que cierra el ítem abierto en `start`. */
function findItemClose(tokens: BlockToken[], start: number): number {
  let depth = 0;
  for (let i = start; i < tokens.length; i++) {
    if (tokens[i].type === "list_item_open") {
      depth++;
    } else if (tokens[i].type === "list_item_close") {
      depth--;
      if (depth === 0) {
        return i;
      }
    }
  }
  return tokens.length - 1;
}

/** Primer texto en línea dentro del bloque de cita abierto en `start`. */
function firstInlineOfBlockquote(
  tokens: BlockToken[],
  start: number
): string {
  for (let i = start + 1; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.type === "inline") {
      return t.content;
    }
    if (t.type === "blockquote_close" || t.level < tokens[start].level) {
      break;
    }
  }
  return "";
}

/**
 * Devuelve true si el bloque que empieza en `index` es una respuesta
 * (párrafo o cita "Answer:"/"Respuesta:"). Los párrafos consumidos como
 * respuesta se marcan en `consumed` para no emitirlos como preguntas.
 */
function nextBlockIsAnswer(
  tokens: BlockToken[],
  index: number,
  consumed: Set<number>
): boolean {
  const t = tokens[index];
  if (!t) {
    return false;
  }
  if (t.type === "paragraph_open") {
    if (isAnswerText(tokens[index + 1]?.content ?? "")) {
      consumed.add(index);
      return true;
    }
    return false;
  }
  if (t.type === "blockquote_open") {
    return isAnswerText(firstInlineOfBlockquote(tokens, index));
  }
  return false;
}

/** Devuelve true si el ítem contiene una respuesta en un bloque subordinado. */
function itemHasAnswer(
  tokens: BlockToken[],
  start: number,
  end: number
): boolean {
  const itemLevel = tokens[start].level;
  for (let i = start + 1; i < end; i++) {
    const t = tokens[i];
    if (t.level !== itemLevel + 1) {
      continue; // solo hijos directos del ítem, nunca bloques de ítems anidados
    }
    if (t.type === "paragraph_open") {
      // Cualquier línea del párrafo puede ser la respuesta subyacente.
      const content = tokens[i + 1]?.content ?? "";
      if (content.split("\n").some((l) => isAnswerText(l))) {
        return true;
      }
    } else if (t.type === "blockquote_open") {
      if (isAnswerText(firstInlineOfBlockquote(tokens, i))) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Indentación del contenido de un ítem de lista a partir de su línea fuente.
 * Columnas reales CommonMark: cada tabulador —en el prefijo o tras el
 * marcador— avanza al siguiente múltiplo de 4 desde la columna actual; con
 * un gap de 1–4 columnas el contenido empieza tras él, con 5+ empieza un
 * espacio después del marcador.
 */
function itemIndent(lineSource: string): string {
  const m = lineSource.match(/^([ \t]*)([-+*]|\d+[.)])([ \t]+)/);
  if (!m) {
    return "  ";
  }
  const advance = (col: number, ch: string) =>
    ch === "\t" ? col + 4 - (col % 4) : col + 1;
  let col = 0;
  for (const ch of m[1]) {
    col = advance(col, ch);
  }
  const markerEnd = col + m[2].length;
  col = markerEnd;
  for (const ch of m[3]) {
    col = advance(col, ch);
  }
  const gap = col - markerEnd;
  return " ".repeat(gap <= 4 ? col : markerEnd + 1);
}

/**
 * Escapa la primera marca de bloque de una línea de respuesta para que, dentro
 * de la cita, no pueda crear encabezados, listas, citas anidadas ni fences.
 */
function escapeAnswerLine(line: string): string {
  const m = line.match(/^(\s*)(.*)$/)!;
  const pad = m[1];
  const body = m[2];
  if (!body) {
    return line;
  }
  const ordered = body.match(/^(\d+)([.)])(?=\s|$)/);
  if (ordered) {
    // Lista ordenada: se escapa el delimitador (1\. 2\)).
    return `${pad}${ordered[1]}\\${ordered[2]}${body.slice(ordered[0].length)}`;
  }
  const BLOCK_START = [
    /^#{1,6}(?=\s|$)/, // encabezado ATX
    /^[-+*](?=\s|$)/, // lista con viñetas
    /^>/, // cita anidada
    /^`{3,}/, // fence de código
    /^~{3,}/, // fence alternativo
    /^<(?=[a-zA-Z!/?])/, // bloque HTML
    /^\[[^\]]*\]:/, // definición de referencia [id]:
    /^[*\-=_]{3,}\s*$/, // regla temática o subrayado setext
    /^\|/, // tabla GFM
    /^[*_`~]/, // énfasis/decoración al inicio: se muestra literal
    /^\\/, // barra inicial: se escapa para no comerse el carácter siguiente
  ];
  return BLOCK_START.some((re) => re.test(body)) ? `${pad}\\${body}` : line;
}

/** Parsea el contenido y devuelve las preguntas abiertas pendientes. */
export function parseQuestions(content: string): OpenQuestion[] {
  // Se normaliza el BOM antes de parsear para no desplazar la línea 0.
  content = stripBom(content);
  const lines = content.split(/\r?\n/);
  const tokens = md.parse(content, {}) as unknown as BlockToken[];
  const questions: OpenQuestion[] = [];
  // Bloques consumidos como respuesta (para no emitirlos como preguntas).
  const consumed = new Set<number>();
  // Textos de TODOS los candidatos (pendientes o resueltos), en orden:
  // fija la ocurrencia estable de cada pregunta para claves de borrador.
  const candidates: string[] = [];

  let section: SectionMode | null = null;
  let sectionLevel = 0;
  let quoteDepth = 0;
  // Pila de subencabezados estructurales vigentes (solo dentro de sección):
  // el último apilado es el título de grupo más cercano.
  const headingStack: Array<{ level: number; title: string }> = [];

  const collapse = (text: string) => text.replace(/\s+/g, " ").trim();

  /** Registra un candidato y devuelve su índice de ocurrencia (0-based). */
  const registerCandidate = (text: string): number => {
    let occurrence = 0;
    for (const c of candidates) {
      if (c === text) {
        occurrence++;
      }
    }
    candidates.push(text);
    return occurrence;
  };

  const pushQuestion = (
    text: string,
    occurrence: number,
    start: number,
    end: number,
    indent: string,
    groupTitle?: string
  ) => {
    questions.push({
      text,
      line: start,
      blockEnd: end,
      indent,
      snapshot: lines.slice(start, end).join("\n"),
      occurrence,
      groupTitle,
    });
  };

  /**
   * Procesa un ítem de lista según el modo vigente y recorre sus ítems de
   * listas hijas DIRECTAS (level + 2), que pueden ser preguntas independientes
   * aunque el padre no lo sea o esté marcado. Las preguntas se registran en
   * orden de documento para ocurrencias estables.
   */
  const processListItem = (
    start: number,
    end: number,
    mode: SectionMode | "outside",
    inheritedTitle?: string
  ) => {
    const item = tokens[start];
    if (!item.map) {
      return;
    }
    // Primer párrafo del ítem: solo un hijo DIRECTO (nunca dentro de un
    // ítem anidado ni de una cita) aporta el texto visible de la pregunta.
    let firstText = "";
    for (let i = start + 1; i < end; i++) {
      if (
        tokens[i].type === "paragraph_open" &&
        tokens[i].level === item.level + 1
      ) {
        firstText = visibleText(tokens[i + 1]);
        break;
      }
    }
    const done = /^\s*\[[xX]\]/.test(firstText);
    const unchecked = !done && /^\s*\[ \]\s*\S/.test(firstText);
    const text = collapse(firstText.replace(/^\s*\[[xX ]\]\s*/, ""));
    const question = text !== "" && isQuestionText(text);
    let isCandidate = false;
    if (!done && text !== "") {
      if (mode === "questions") {
        isCandidate = question || unchecked;
      } else if (mode === "decisions") {
        // También declarativos, salvo rótulos de agrupación que terminan en
        // ":" sin pregunta, prefijo ni checkbox.
        isCandidate = question || unchecked || !text.endsWith(":");
      } else {
        isCandidate = hasQuestionPrefix(text);
      }
    }
    if (isCandidate) {
      const occurrence = registerCandidate(text);
      // Respuesta en el propio ítem (solo hijos directos): la resuelve.
      if (!itemHasAnswer(tokens, start, end)) {
        pushQuestion(
          text,
          occurrence,
          item.map[0],
          item.map[1],
          itemIndent(lines[item.map[0]] ?? ""),
          inheritedTitle
        );
      }
    }
    // Rótulo estructural: ítem no candidato (sin pregunta, prefijo ni
    // checkbox) cuyo texto visible termina en ":" — su título, sin los dos
    // puntos finales, se propaga a sus descendientes y sobrescribe el
    // heredado; los padres que son preguntas nunca aportan título.
    const structuralLabel =
      !done && !unchecked && !isCandidate && !question && text.endsWith(":")
        ? text.replace(/:+$/, "") || null
        : null;
    const childTitle = structuralLabel ?? inheritedTitle;
    // Ítems de listas hijas directas: level + 2 los distingue de los que
    // están dentro de citas o sublistas más profundas (los recorre su padre).
    for (let i = start + 1; i < end; i++) {
      const t = tokens[i];
      if (t.type === "list_item_open" && t.level === item.level + 2) {
        const childEnd = findItemClose(tokens, i);
        processListItem(i, childEnd, mode, childTitle);
        i = childEnd;
      }
    }
  };

  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];

    // El contenido de las citas se ignora por completo.
    if (tok.type === "blockquote_open") {
      quoteDepth++;
      continue;
    }
    if (tok.type === "blockquote_close") {
      quoteDepth--;
      continue;
    }
    if (quoteDepth > 0 || consumed.has(i)) {
      continue;
    }

    if (tok.type === "heading_open") {
      const level = Number(tok.tag.slice(1)) || 1;
      const text = visibleText(tokens[i + 1]);
      // Se descartan los títulos estructurales de nivel igual o inferior.
      while (
        headingStack.length > 0 &&
        headingStack[headingStack.length - 1].level >= level
      ) {
        headingStack.pop();
      }
      if (section && level <= sectionLevel) {
        section = null; // un encabezado igual o menor cierra la sección
        headingStack.length = 0;
      }
      const mode = matchSection(text);
      if (mode) {
        section = mode;
        sectionLevel = level;
        // Nueva sección (incluso reconocida anidada): su título nunca es de
        // grupo y el contexto anterior se descarta.
        headingStack.length = 0;
      } else if (tok.map) {
        // Pregunta por encabezado: subordinado dentro de sección, o con
        // prefijo explícito en cualquier parte ("### Open Question: …").
        const isCandidate = section
          ? isQuestionText(text)
          : hasQuestionPrefix(text);
        if (isCandidate) {
          const occurrence = registerCandidate(collapse(text));
          if (!nextBlockIsAnswer(tokens, i + 3, consumed)) {
            pushQuestion(
              collapse(text),
              occurrence,
              tok.map[0],
              tok.map[1],
              "",
              section ? headingStack[headingStack.length - 1]?.title : undefined
            );
          }
        } else if (section) {
          // Subencabezado estructural no candidato: título de grupo para lo
          // que venga después (nunca el título de la propia sección).
          const title = collapse(text);
          if (title) {
            headingStack.push({ level, title });
          }
        }
      }
      i += 2; // heading_open + inline + heading_close
      continue;
    }

    if (tok.type === "list_item_open") {
      const end = findItemClose(tokens, i);
      // Solo ítems top-level (level 1): los anidados los recorre
      // processListItem heredando el modo, y los de citas nunca llegan
      // (quoteDepth los descarta antes).
      if (tok.level === 1) {
        processListItem(
          i,
          end,
          section ?? "outside",
          section ? headingStack[headingStack.length - 1]?.title : undefined
        );
      }
      i = end; // saltamos el contenido del ítem completo
      continue;
    }

    if (tok.type === "paragraph_open" && tok.map) {
      const text = visibleText(tokens[i + 1]);
      const isCandidate = section
        ? isQuestionText(text)
        : hasQuestionPrefix(text);
      if (isCandidate) {
        const occurrence = registerCandidate(collapse(text));
        if (!nextBlockIsAnswer(tokens, i + 3, consumed)) {
          pushQuestion(
            collapse(text),
            occurrence,
            tok.map[0],
            tok.map[1],
            "",
            section ? headingStack[headingStack.length - 1]?.title : undefined
          );
        }
      }
      i += 2; // paragraph_open + inline + paragraph_close
      continue;
    }
  }

  return questions;
}

/** Devuelve true para los tipos de artefacto que admiten preguntas. */
export function isQuestionArtifact(kind: string): boolean {
  return kind === "proposal" || kind === "design";
}

/** Lee y parsea las preguntas de un archivo; devuelve [] si hay error. */
export function readQuestions(fsPath: string): OpenQuestion[] {
  try {
    return parseQuestions(fs.readFileSync(fsPath, "utf8"));
  } catch {
    return [];
  }
}

/**
 * Calcula la inserción de una respuesta, o undefined si la respuesta está
 * vacía o la pregunta ya no está en esa posición / ya está resuelta.
 */
export function planQuestionAnswer(
  content: string,
  question: OpenQuestion,
  answer: string
): AnswerInsertion | undefined {
  const trimmed = answer.trim();
  if (!trimmed) {
    return undefined;
  }
  // Las posiciones son por línea: el BOM solo prefija la línea 0 y no cambia
  // la estructura de líneas; se normaliza para parsear igual que el documento.
  const body = stripBom(content);
  // La pregunta debe seguir en la misma posición, con el mismo bloque y
  // pendiente: si el snapshot cambió o ya tiene respuesta, se aborta.
  const current = parseQuestions(body).find(
    (q) =>
      q.line === question.line &&
      q.text === question.text &&
      q.snapshot === question.snapshot
  );
  if (!current) {
    return undefined;
  }

  const lines = body.split(/\r?\n/);
  const eol = body.includes("\r\n") ? "\r\n" : "\n";
  const insertAt = current.blockEnd;
  const indent = current.indent;

  // Separación de párrafo entre el bloque original y la cita de respuesta.
  // Se mira la línea ANTERIOR al punto de inserción: el map de un ítem ya
  // incluye la línea en blanco final, y dos blancos seguidos cerrarían la
  // lista (la cita quedaría fuera del ítem).
  const snippet: string[] = [];
  const prevLine = lines[insertAt - 1];
  if (prevLine === undefined || prevLine.trim() !== "") {
    snippet.push("");
  }
  const answerLines = trimmed.replace(/\r\n?/g, "\n").split("\n");
  // La primera línea también se escapa: debe representar texto literal visible.
  snippet.push(`${indent}> **Answer:** ${escapeAnswerLine(answerLines[0])}`);
  for (const raw of answerLines.slice(1)) {
    snippet.push(
      raw.trim() === "" ? `${indent}>` : `${indent}> ${escapeAnswerLine(raw)}`
    );
  }

  if (insertAt < lines.length) {
    // Inserción al inicio de una línea existente: bloque de líneas completas.
    return { line: insertAt, character: 0, text: snippet.join(eol) + eol };
  }
  // Fin de archivo sin terminador: se añade sin crear una línea final nueva.
  const last = lines[lines.length - 1] ?? "";
  return {
    line: lines.length - 1,
    character: last.length,
    text: eol + snippet.join(eol),
  };
}

/**
 * Inserta la respuesta como cita "> **Answer:** …" al final del bloque de la
 * pregunta. Devuelve el contenido nuevo, o undefined si la pregunta ya no
 * coincide con su snapshot o está resuelta. El texto original nunca se
 * reemplaza y se preservan CRLF y el terminador (o su ausencia).
 */
export function insertQuestionAnswer(
  content: string,
  question: OpenQuestion,
  answer: string
): string | undefined {
  // Trabaja sobre el contenido sin BOM y lo reincorpora al devolver.
  const bom = content.charCodeAt(0) === 0xfeff;
  const body = bom ? content.slice(1) : content;
  const plan = planQuestionAnswer(body, question, answer);
  if (!plan) {
    return undefined;
  }
  const offset = offsetOf(body, plan.line, plan.character);
  const inserted = body.slice(0, offset) + plan.text + body.slice(offset);
  return bom ? "\uFEFF" + inserted : inserted;
}

/** Offset de carácter en `content` para la posición (line, character). */
function offsetOf(content: string, line: number, character: number): number {
  if (line <= 0) {
    return character;
  }
  const re = /\r\n|\r|\n/g;
  let m: RegExpExecArray | null;
  let current = 0;
  while ((m = re.exec(content)) !== null) {
    current++;
    if (current === line) {
      return m.index + m[0].length + character;
    }
  }
  return content.length;
}
