// Pruebas de regresión del módulo puro src/openspec/questions.ts.
// Se compila al vuelo con esbuild (devDependency existente, write:false) y se
// importa vía data URL — no deja artefactos temporales ni dependencias nuevas.
import test from "node:test";
import assert from "node:assert/strict";
import esbuild from "esbuild";
import { fileURLToPath } from "node:url";
import * as path from "node:path";
import * as os from "node:os";
import * as fs from "node:fs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const built = esbuild.buildSync({
  entryPoints: [path.join(root, "src", "openspec", "questions.ts")],
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node18",
  write: false,
});
const code = built.outputFiles[0].text;
const {
  parseQuestions,
  insertQuestionAnswer,
  planQuestionAnswer,
  isQuestionArtifact,
  readQuestions,
} = await import(
  "data:text/javascript;base64," + Buffer.from(code).toString("base64")
);

// --- Detección dentro de secciones ---

test("detecta preguntas en secciones en inglés y español", () => {
  const content = [
    "# Proposal",
    "",
    "## Open Questions",
    "",
    "- [ ] Which database?",
    "- Which cache?",
    "",
    "## Preguntas abiertas",
    "",
    "1. ¿Qué formato se exporta?",
    "",
    "## Decisiones pendientes:",
    "",
    "- Decisión sin resolver",
    "",
    "## Otra sección",
    "",
    "Texto fuera de sección que no cuenta?",
  ].join("\n");
  const qs = parseQuestions(content);
  assert.deepEqual(
    qs.map((q) => q.text),
    ["Which database?", "Which cache?", "¿Qué formato se exporta?", "Decisión sin resolver"]
  );
  assert.deepEqual(qs.map((q) => q.line), [4, 5, 9, 13]);
});

test("un encabezado igual o menor cierra la sección", () => {
  const content = [
    "## Open Questions",
    "",
    "- Pending one?",
    "",
    "### Structural subsection",
    "",
    "- Still inside?", // subsección estructural no cierra la sección
    "",
    "## Other section",
    "",
    "- Not counted?",
    "",
    "Paragraph not counted?",
  ].join("\n");
  const qs = parseQuestions(content);
  assert.deepEqual(qs.map((q) => q.text), ["Pending one?", "Still inside?"]);
});

test("encabezados subordinados que son preguntas cuentan; estructurales no", () => {
  const content = [
    "## Open Questions",
    "",
    "### What is the scope?",
    "",
    "### Structural",
    "",
    "Intro text here.",
    "",
    "#### Deeper heading question?",
  ].join("\n");
  const qs = parseQuestions(content);
  assert.deepEqual(
    qs.map((q) => q.text),
    ["What is the scope?", "Deeper heading question?"]
  );
});

test("listas: ordenadas, viñetas y checks; [x] se ignora", () => {
  const content = [
    "## Open Questions",
    "",
    "- [ ] pending check",
    "- [x] resolved check",
    "* star bullet?",
    "1. ordered item?",
    "2) paren ordered?",
    "-    ",
    "- [ ]   ",
  ].join("\n");
  const qs = parseQuestions(content);
  assert.deepEqual(
    qs.map((q) => q.text),
    ["pending check", "star bullet?", "ordered item?", "paren ordered?"]
  );
});

test("párrafos dentro de sección: solo preguntas o prefijos", () => {
  const content = [
    "## Asuntos pendientes",
    "",
    "A plain paragraph is not a question.",
    "",
    "Is this one a question?",
    "",
    "Open Question: explicit one",
  ].join("\n");
  const qs = parseQuestions(content);
  assert.deepEqual(
    qs.map((q) => q.text),
    ["Is this one a question?", "Open Question: explicit one"]
  );
});

// --- Detección fuera de secciones ---

test("fuera de sección solo cuentan prefijos explícitos (con negritas)", () => {
  const content = [
    "# Doc",
    "",
    "Open Question: which api?",
    "",
    "**Pregunta abierta:** ¿qué versión?",
    "",
    "- Pending Decision: where to store?",
    "",
    "Asunto pendiente: ¿hay límite?",
    "",
    "A narrative question outside? ignored",
    "",
    "- Another narrative item? ignored",
  ].join("\n");
  const qs = parseQuestions(content);
  // El texto visible no lleva marcas de formato ("**" se elimina).
  assert.deepEqual(
    qs.map((q) => q.text),
    [
      "Open Question: which api?",
      "Pregunta abierta: ¿qué versión?",
      "Pending Decision: where to store?",
      "Asunto pendiente: ¿hay límite?",
    ]
  );
});

test("no detecta preguntas en fences ni citas", () => {
  const content = [
    "## Open Questions",
    "",
    "```",
    "- fake question?",
    "```",
    "",
    "> - quoted question?",
    "> Pending Decision: quoted",
    "",
    "    - code block question?",
    "",
    "- real question?",
  ].join("\n");
  const qs = parseQuestions(content);
  assert.deepEqual(qs.map((q) => q.text), ["real question?"]);
});

test("ítems anidados con pregunta o checkbox sí cuentan", () => {
  const content = [
    "## Open Questions",
    "",
    "- top level?",
    "  - nested counts?",
    "  - [ ] nested check counts",
    "  - nested declarative ignored",
    "- other top?",
  ].join("\n");
  const qs = parseQuestions(content);
  assert.deepEqual(qs.map((q) => q.text), [
    "top level?",
    "nested counts?",
    "nested check counts",
    "other top?",
  ]);
});

// --- Preguntas resueltas ---

test("respuestas manuales existentes se reconocen en párrafo y cita", () => {
  const content = [
    "## Open Questions",
    "",
    "Solved paragraph?",
    "",
    "Answer: we chose A.",
    "",
    "Solved by quote?",
    "",
    "> Respuesta: sí, resuelta.",
    "",
    "Still pending?",
  ].join("\n");
  const qs = parseQuestions(content);
  assert.deepEqual(qs.map((q) => q.text), ["Still pending?"]);
});

test("respuesta dentro del ítem lo resuelve; la de otro ítem no", () => {
  const content = [
    "## Open Questions",
    "",
    "- first?",
    "",
    "  > **Answer:** decided",
    "",
    "- second?",
    "",
    "- third? and its quote follows",
    "",
    "> **Answer:** not inside any item",
    "",
    "- fourth?",
  ].join("\n");
  // "first" resuelto por cita interna; "third" NO (la cita es de nivel tope,
  // no pertenece al ítem); "fourth" pendiente.
  const qs = parseQuestions(content);
  assert.deepEqual(qs.map((q) => q.text), ["second?", "third? and its quote follows", "fourth?"]);
});

test("respuesta vacía no resuelve", () => {
  const content = [
    "## Open Questions",
    "",
    "Pending?",
    "",
    "> **Answer:**",
    "",
    "- also pending?",
    "  Answer:",
  ].join("\n");
  const qs = parseQuestions(content);
  assert.equal(qs.length, 2);
});

// --- Inserción de respuestas ---

test("inserta la respuesta como cita dentro del ítem de lista", () => {
  const content = [
    "# Doc",
    "",
    "## Open Questions",
    "",
    "- Which db?",
    "",
    "## Next",
  ].join("\n");
  const [q] = parseQuestions(content);
  const out = insertQuestionAnswer(content, q, "Postgres");
  // La línea en blanco del ítem queda antes de la cita; el siguiente
  // encabezado cierra el bloque sin separador extra.
  assert.equal(
    out,
    [
      "# Doc",
      "",
      "## Open Questions",
      "",
      "- Which db?",
      "",
      "  > **Answer:** Postgres",
      "## Next",
    ].join("\n")
  );
  // Al releer, la pregunta ya no está pendiente.
  assert.equal(parseQuestions(out).length, 0);
});

test("inserta respuesta tras párrafo pregunta sin tocar el resto", () => {
  const content = ["Is it ready?", "", "Tail text."].join("\n");
  // Párrafo fuera de sección sin prefijo no es pregunta: nada que responder.
  assert.equal(parseQuestions(content).length, 0);
  const content2 = [
    "## Open Questions",
    "",
    "Is it ready?",
    "",
    "Tail text.",
  ].join("\n");
  const [q] = parseQuestions(content2);
  const out = insertQuestionAnswer(content2, q, "Yes, shipped");
  assert.equal(
    out,
    [
      "## Open Questions",
      "",
      "Is it ready?",
      "",
      "> **Answer:** Yes, shipped",
      "",
      "Tail text.",
    ].join("\n")
  );
});

test("preserva CRLF y ausencia de terminador final", () => {
  const content = "## Open Questions\r\n\r\n- Which db?\r\n\r\n- Other?";
  const [q1, q2] = parseQuestions(content);
  // Responde la última pregunta (fin de archivo sin newline).
  const out = insertQuestionAnswer(content, q2, "respuesta final");
  assert.equal(
    out,
    "## Open Questions\r\n\r\n- Which db?\r\n\r\n- Other?\r\n\r\n  > **Answer:** respuesta final"
  );
  // Responde la primera (mitad de archivo).
  const out2 = insertQuestionAnswer(content, q1, "mid answer");
  assert.equal(
    out2,
    "## Open Questions\r\n\r\n- Which db?\r\n\r\n  > **Answer:** mid answer\r\n- Other?"
  );
  // Con terminador final se conserva.
  const trailing = "## Open Questions\r\n\r\n- Which db?\r\n";
  const [t] = parseQuestions(trailing);
  const out3 = insertQuestionAnswer(trailing, t, "x");
  assert.ok(out3.endsWith("\r\n"));
  assert.equal(parseQuestions(out3).length, 0);
});

test("respuestas multilínea no pueden crear bloques ni preguntas", () => {
  const content = "## Open Questions\n\n- Which db?";
  const [q] = parseQuestions(content);
  const answer = "First line\n# Fake heading\n- fake item\n1. fake ordered\n> fake quote\n\nlast line";
  const out = insertQuestionAnswer(content, q, answer);
  assert.ok(out);
  // Cada línea de la respuesta queda dentro de la cita.
  assert.ok(out.includes("  > **Answer:** First line"));
  assert.ok(out.includes("  > \\# Fake heading"));
  assert.ok(out.includes("  > \\- fake item"));
  assert.ok(out.includes("  > 1\\. fake ordered"));
  assert.ok(out.includes("  > \\> fake quote"));
  assert.ok(out.includes("  >"));
  assert.ok(out.includes("  > last line"));
  // Al releer no se generan preguntas nuevas.
  assert.equal(parseQuestions(out).length, 0);
});

test("preguntas idénticas: solo se resuelve la seleccionada", () => {
  const content = [
    "## Open Questions",
    "",
    "- Same text?",
    "",
    "- Same text?",
  ].join("\n");
  const [first, second] = parseQuestions(content);
  assert.notEqual(first.line, second.line);
  assert.equal(first.occurrence, 0);
  assert.equal(second.occurrence, 1);
  const out = insertQuestionAnswer(content, second, "answered second");
  const remaining = parseQuestions(out);
  assert.equal(remaining.length, 1);
  assert.equal(remaining[0].line, first.line);
});

test("resolver la primera duplicada conserva la identidad de la segunda", () => {
  const content = "## Open Questions\n\n- Same?\n\n- Same?";
  const [first] = parseQuestions(content);
  const out = insertQuestionAnswer(content, first, "answered first");
  const remaining = parseQuestions(out);
  assert.equal(remaining.length, 1);
  assert.equal(remaining[0].text, "Same?");
  // La duplicada resuelta sigue contando como candidato: la ocurrencia de la
  // segunda no se reasigna (clave de borrador estable).
  assert.equal(remaining[0].occurrence, 1);
});

test("duplicada padre/hija: ocurrencias estables al resolver cualquiera", () => {
  const content = "## Open Questions\n\n- Same?\n  - Same?";
  const [padre, hija] = parseQuestions(content);
  assert.equal(padre.occurrence, 0);
  assert.equal(hija.occurrence, 1);
  // Resolviendo el padre, la hija conserva occurrence=1.
  const out1 = insertQuestionAnswer(content, padre, "r1");
  const rest1 = parseQuestions(out1);
  assert.equal(rest1.length, 1);
  assert.equal(rest1[0].text, "Same?");
  assert.equal(rest1[0].occurrence, 1);
  // Resolviendo la hija, el padre conserva occurrence=0.
  const out2 = insertQuestionAnswer(content, hija, "r2");
  const rest2 = parseQuestions(out2);
  assert.equal(rest2.length, 1);
  assert.equal(rest2[0].text, "Same?");
  assert.equal(rest2[0].occurrence, 0);
});

test("respuestas de solo puntuación resuelven, no quedan pendientes", () => {
  for (const answer of ["***", "`", "___", "~~~", "\\"]) {
    const content = "## Open Questions\n\n- Which db?";
    const [q] = parseQuestions(content);
    const out = insertQuestionAnswer(content, q, answer);
    assert.ok(out, `insert failed for ${answer}`);
    assert.equal(
      parseQuestions(out).length,
      0,
      `answer ${answer} left the question pending`
    );
  }
});

test("sangría real CommonMark: varios espacios tras el marcador", () => {
  const content = "## Open Questions\n\n-   What's my indent?";
  const [q] = parseQuestions(content);
  assert.equal(q.indent, "    "); // '-' + 3 espacios = 4
  const out = insertQuestionAnswer(content, q, "x");
  assert.ok(out.includes("\n    > **Answer:** x"));
  assert.equal(parseQuestions(out).length, 0);
});

test("sangría CommonMark con tabuladores en prefijo y gap", () => {
  // [contenido, índice de la pregunta, indent esperado en espacios]
  const cases = [
    // Tab de prefijo bajo "10.": tab→4 + "- " = 6 columnas.
    ["## Open Questions\n\n10. Group:\n\t- ¿Nested?", 0, "      "],
    // Gap solo tab: fin de marcador 1, tab→4 (gap 3) = columna 4.
    ["## Open Questions\n\n- \t¿Gap tab?", 0, "    "],
    // Gap mixto: 1→2 espacio, →4 tab, →5 espacio (gap 4) = columna 5.
    ["## Open Questions\n\n- \t ¿Gap mixto?", 0, "     "],
  ];
  for (const [content, idx, indent] of cases) {
    const qs = parseQuestions(content);
    assert.ok(qs.length > idx, `no question in ${JSON.stringify(content)}`);
    const q = qs[idx];
    assert.equal(q.indent, indent, `indent for ${JSON.stringify(content)}`);
    const out = insertQuestionAnswer(content, q, "x");
    assert.ok(out, `insert failed for ${JSON.stringify(content)}`);
    // Roundtrip: la cita cae dentro del ítem y lo resuelve.
    assert.equal(
      parseQuestions(out).length,
      0,
      `answer did not resolve ${JSON.stringify(content)}`
    );
  }
});

test("ítem raíz sin párrafo directo no es candidato pero su hija real sí", () => {
  const content = [
    "## Open Questions",
    "",
    "- > quoted question?",
    "  - nested question?",
    "",
    "> Pending Decision: quoted",
    "",
    "- real?",
  ].join("\n");
  const qs = parseQuestions(content);
  // El primer ítem no tiene párrafo directo: no es candidato y el texto de
  // la cita no se usa; pero su ítem hija directa sí es pregunta real. La
  // lista dentro de la cita y la cita top-level se ignoran.
  assert.deepEqual(qs.map((q) => q.text), ["nested question?", "real?"]);
});

test("encabezado con prefijo explícito fuera de sección cuenta", () => {
  const content = [
    "# Doc",
    "",
    "### Open Question: which api?",
    "",
    "Some text.",
    "",
    "#### Pending Decision: storage?",
    "",
    "### Regular question heading?",
  ].join("\n");
  const qs = parseQuestions(content);
  assert.deepEqual(
    qs.map((q) => q.text),
    ["Open Question: which api?", "Pending Decision: storage?"]
  );
});

test("encabezado setext también abre sección de preguntas", () => {
  const content = [
    "Open Questions",
    "==============",
    "",
    "- Which db?",
  ].join("\n");
  assert.equal(parseQuestions(content).length, 1);
});

test("archivo con BOM parsea e inserta conservándolo", () => {
  const content = "\uFEFF## Open Questions\r\n\r\n- Which db?";
  const [q] = parseQuestions(content);
  const out = insertQuestionAnswer(content, q, "x");
  assert.ok(out.startsWith("\uFEFF"));
  assert.equal(parseQuestions(out).length, 0);
});

test("rechaza snapshot/posición obsoletos y respuestas vacías", () => {
  const content = "## Open Questions\n\n- Which db?";
  const [q] = parseQuestions(content);
  // Respuesta vacía.
  assert.equal(insertQuestionAnswer(content, q, "   "), undefined);
  // Posición obsoleta: la pregunta se movió de línea.
  const moved = "# Extra\n\n" + content;
  assert.equal(insertQuestionAnswer(moved, q, "x"), undefined);
  // Snapshot obsoleto: la línea existe pero el bloque cambió.
  const changed = "## Open Questions\n\n- Which db engine?\n  extra line";
  assert.equal(insertQuestionAnswer(changed, q, "x"), undefined);
  // Ya resuelta.
  const solved = insertQuestionAnswer(content, q, "done");
  assert.equal(insertQuestionAnswer(solved, q, "again"), undefined);
});

test("planQuestionAnswer devuelve inserción de rango mínimo", () => {
  const content = "## Open Questions\n\n- Which db?";
  const [q] = parseQuestions(content);
  const plan = planQuestionAnswer(content, q, "x");
  assert.deepEqual(plan, {
    line: 2,
    character: 11,
    text: "\n\n  > **Answer:** x",
  });
});

// --- Ítems anidados y modos de sección ---

test("caso real: rótulo con hijas, ítem respondido y declarativo", () => {
  const content = [
    "## Open Questions",
    "",
    "8. **Nivel de logs:** contexto de la decisión. ¿Aplican los niveles estándar?",
    "   > **Answer:** Sí.",
    "",
    "9. **Informe por email (D13):**",
    "   - ¿Quiénes lo reciben? Se propone equipo de soporte.",
    "   - ¿A qué hora es el corte diario? Se propone medianoche.",
    "   - ¿Bastan los criterios de aceptación?",
    "   - ¿Aplica también a fines de semana? Hoy solo laborables.",
    "",
    "- El modo dinámico exige calcular el premio por demanda (D10).",
  ].join("\n");
  const qs = parseQuestions(content);
  // Exactamente las 4 hijas de 9: ni 8 (respondida), ni 9 (rótulo sin "?"),
  // ni D10 (declarativo bajo sección de preguntas).
  assert.equal(qs.length, 4);
  assert.deepEqual(qs.map((q) => q.line), [6, 7, 8, 9]);
  // Sangría absoluta: 3 del ítem numerado + 2 del marcador hija.
  assert.deepEqual(
    qs.map((q) => q.indent),
    ["     ", "     ", "     ", "     "]
  );
  // Texto visible completo, con contexto y sin "**".
  assert.equal(
    qs[0].text,
    "¿Quiénes lo reciben? Se propone equipo de soporte."
  );
  assert.equal(
    qs[3].text,
    "¿Aplica también a fines de semana? Hoy solo laborables."
  );
  // Al responder una quedan las otras tres, en orden y con su línea nueva.
  const out = insertQuestionAnswer(content, qs[0], "Soporte y dirección");
  assert.ok(out.includes("\n     > **Answer:** Soporte y dirección"));
  const rest = parseQuestions(out);
  assert.equal(rest.length, 3);
  // La cita insertada añade 2 líneas (separador + cita): las hijas se mueven.
  assert.deepEqual(rest.map((q) => q.line), [9, 10, 11]);
  assert.deepEqual(
    rest.map((q) => q.text),
    qs.slice(1).map((q) => q.text)
  );
});

test("sección de decisiones: declarativo cuenta, rótulo ':' no", () => {
  const content = [
    "## Decisiones pendientes",
    "",
    "- El modo dinámico exige calcular el premio por demanda (D10).",
    "- **Informe por email (D13):**",
    "  - ¿Quiénes lo reciben?",
    "- Open Question: ¿y esto?",
    "- [ ] Checklist pendiente",
  ].join("\n");
  const qs = parseQuestions(content);
  assert.deepEqual(qs.map((q) => q.text), [
    "El modo dinámico exige calcular el premio por demanda (D10).",
    "¿Quiénes lo reciben?",
    "Open Question: ¿y esto?",
    "Checklist pendiente",
  ]);
});

test("respuestas manuales en ítems anidados los resuelven", () => {
  const content = [
    "## Open Questions",
    "",
    "- ¿Pregunta padre?",
    "  - ¿Hija resuelta por cita?",
    "    > **Answer:** respuesta hija",
    "",
    "  - ¿Hija resuelta por párrafo?",
    "",
    "    Respuesta: por párrafo",
    "",
    "  - ¿Hija pendiente?",
  ].join("\n");
  const qs = parseQuestions(content);
  assert.deepEqual(qs.map((q) => q.text), [
    "¿Pregunta padre?",
    "¿Hija pendiente?",
  ]);
});

test("pregunta padre e hija se resuelven de forma independiente", () => {
  const content = "## Open Questions\n\n- ¿Padre?\n  - ¿Hija?";
  const [padre, hija] = parseQuestions(content);
  assert.deepEqual([padre.line, hija.line], [2, 3]);
  // Responder solo la hija deja al padre pendiente (su respuesta no sube).
  const out1 = insertQuestionAnswer(content, hija, "respuesta hija");
  assert.ok(out1.includes("\n    > **Answer:** respuesta hija"));
  assert.deepEqual(
    parseQuestions(out1).map((q) => q.text),
    ["¿Padre?"]
  );
  // Responder solo el padre deja a la hija pendiente (no baja a las hijas).
  const out2 = insertQuestionAnswer(content, padre, "respuesta padre");
  assert.ok(out2.includes("\n  > **Answer:** respuesta padre"));
  assert.deepEqual(
    parseQuestions(out2).map((q) => q.text),
    ["¿Hija?"]
  );
});

test("[x] resuelve el propio ítem pero no suprime preguntas hijas", () => {
  const content = [
    "## Open Questions",
    "",
    "- [x] Ítem completado",
    "  - ¿Hija pendiente?",
    "- [ ] Checkbox pendiente",
  ].join("\n");
  const qs = parseQuestions(content);
  assert.deepEqual(qs.map((q) => q.text), [
    "¿Hija pendiente?",
    "Checkbox pendiente",
  ]);
});

test("prefijo explícito en lista anidada fuera de sección cuenta", () => {
  const content = [
    "# Doc",
    "",
    "- Ítem narrativo",
    "  - Pending Decision: ¿cuál?",
    "  - Otro narrativo? ignorado",
  ].join("\n");
  const qs = parseQuestions(content);
  assert.deepEqual(qs.map((q) => q.text), ["Pending Decision: ¿cuál?"]);
});

test("'?' en destino de enlace no hace pregunta y el formato se limpia", () => {
  const content = [
    "## Open Questions",
    "",
    "- Revisar [el doc](https://e.com/?a=1) para contexto",
    "- ¿Es **real** la [pregunta](https://e.com/) con `código`?",
  ].join("\n");
  const qs = parseQuestions(content);
  assert.deepEqual(qs.map((q) => q.text), [
    "¿Es real la pregunta con código?",
  ]);
});

test("anidado doble bajo '10.' con CRLF, antes de raíz y al final", () => {
  const content = [
    "## Open Questions",
    "",
    "10. **Grupo:**",
    "    - ¿Hija directa?",
    "      - ¿Nieta?",
    "    - ¿Última hija?",
    "",
    "11. ¿Raíz siguiente?",
  ].join("\r\n");
  const qs = parseQuestions(content);
  assert.deepEqual(qs.map((q) => q.text), [
    "¿Hija directa?",
    "¿Nieta?",
    "¿Última hija?",
    "¿Raíz siguiente?",
  ]);
  assert.deepEqual(qs.map((q) => q.line), [3, 4, 5, 7]);
  // Sangrías absolutas: hija 4+2=6, nieta 6+2=8.
  const nieta = qs[1];
  assert.equal(nieta.indent, "        ");
  const out = insertQuestionAnswer(content, nieta, "respuesta nieta");
  assert.ok(out.includes("\r\n        > **Answer:** respuesta nieta"));
  const rest = parseQuestions(out);
  assert.deepEqual(rest.map((q) => q.text), [
    "¿Hija directa?",
    "¿Última hija?",
    "¿Raíz siguiente?",
  ]);
  // Última hija a fin de archivo sin terminador.
  const eof = "## Open Questions\n\n- ¿Padre?\n  - ¿Hija al final?";
  const hija = parseQuestions(eof)[1];
  const out2 = insertQuestionAnswer(eof, hija, "x");
  assert.ok(out2.endsWith("\n    > **Answer:** x"));
  assert.equal(parseQuestions(out2).length, 1);
});

// --- Títulos de grupo (groupTitle) ---

test("groupTitle desde subencabezado estructural, sin línea en blanco", () => {
  const content = [
    "# Preguntas abiertas",
    "## **Informe** de por email (D13)",
    "- pregunta 1?",
    "- pregunta 2?",
  ].join("\n");
  const qs = parseQuestions(content);
  assert.equal(qs.length, 2);
  // Énfasis eliminado del título.
  assert.deepEqual(
    qs.map((q) => q.groupTitle),
    ["Informe de por email (D13)", "Informe de por email (D13)"]
  );
});

test("preguntas al inicio de la sección no tienen título", () => {
  const content = [
    "## Open Questions",
    "",
    "- early?",
    "",
    "### Grupo",
    "",
    "- grouped?",
  ].join("\n");
  const [a, b] = parseQuestions(content);
  assert.equal(a.groupTitle, undefined);
  assert.equal(b.groupTitle, "Grupo");
});

test("títulos hermanos/profundos y descarte al cerrar o abrir sección", () => {
  const content = [
    "# Preguntas abiertas",
    "",
    "## Grupo A",
    "",
    "### Sub A",
    "",
    "- en sub a?",
    "",
    "## Grupo B",
    "",
    "- en b?",
    "",
    "# Otra sección",
    "",
    "- fuera?",
    "",
    "## Open Questions",
    "",
    "- sin titulo?",
  ].join("\n");
  const qs = parseQuestions(content);
  assert.deepEqual(qs.map((q) => q.text), ["en sub a?", "en b?", "sin titulo?"]);
  assert.deepEqual(
    qs.map((q) => q.groupTitle),
    ["Sub A", "Grupo B", undefined]
  );
});

test("encabezado que es pregunta no se convierte en título de grupo", () => {
  const content = [
    "## Open Questions",
    "",
    "### Grupo",
    "",
    "#### ¿Pregunta en heading?",
    "",
    "- ¿Item siguiente?",
  ].join("\n");
  const qs = parseQuestions(content);
  assert.deepEqual(qs.map((q) => q.text), [
    "¿Pregunta en heading?",
    "¿Item siguiente?",
  ]);
  // Ambas heredan el título superior; la pregunta-heading no lo reemplaza.
  assert.deepEqual(
    qs.map((q) => q.groupTitle),
    ["Grupo", "Grupo"]
  );
});

test("rótulo de ítem tiene prioridad y se restaura para hermanos", () => {
  const content = [
    "## Open Questions",
    "",
    "### Encabezado",
    "",
    "- top antes?",
    "",
    "9. **Informe por email (D13):**",
    "   - ¿Hija etiquetada?",
    "",
    "- top despues?",
  ].join("\n");
  const qs = parseQuestions(content);
  assert.deepEqual(
    qs.map((q) => q.groupTitle),
    ["Encabezado", "Informe por email (D13)", "Encabezado"]
  );
});

test("rótulo de ítem fuera de sección aplica a prefijos explícitos", () => {
  const content = [
    "# Doc",
    "",
    "- Informe por email (D13):",
    "  - Pending Decision: ¿cuál?",
    "",
    "- Sin rótulo",
    "  - Pending Decision: ¿otro?",
  ].join("\n");
  const [q1, q2] = parseQuestions(content);
  assert.equal(q1.groupTitle, "Informe por email (D13)");
  assert.equal(q2.groupTitle, undefined); // padre sin ":" no aporta título
});

test("resolver una de dos bajo el mismo título conserva el del otro", () => {
  const content = [
    "## Open Questions",
    "",
    "### Grupo",
    "",
    "- q1?",
    "- q2?",
  ].join("\n");
  const [q1] = parseQuestions(content);
  const out = insertQuestionAnswer(content, q1, "done");
  // El encabezado no se modifica al insertar la respuesta.
  assert.ok(out.includes("### Grupo"));
  const rest = parseQuestions(out);
  assert.equal(rest.length, 1);
  assert.equal(rest[0].text, "q2?");
  assert.equal(rest[0].groupTitle, "Grupo");
});

// --- Utilidades ---

test("isQuestionArtifact solo para proposal/design", () => {
  assert.equal(isQuestionArtifact("proposal"), true);
  assert.equal(isQuestionArtifact("design"), true);
  assert.equal(isQuestionArtifact("tasks"), false);
  assert.equal(isQuestionArtifact("spec"), false);
  assert.equal(isQuestionArtifact("generic"), false);
});

test("readQuestions tolera errores y lee archivos reales", () => {
  assert.deepEqual(readQuestions("/no/existe/archivo.md"), []);
  const tmp = path.join(os.tmpdir(), `oq-${process.pid}.md`);
  fs.writeFileSync(tmp, "## Open Questions\n\n- Real?\n", "utf8");
  try {
    const qs = readQuestions(tmp);
    assert.equal(qs.length, 1);
    assert.equal(qs[0].text, "Real?");
  } finally {
    fs.unlinkSync(tmp);
  }
});
