// Tests de «Tendencias». Diseño: docs/informes/2026-11-14-diseno-tendencias.md
const test = require("node:test");
const assert = require("node:assert/strict");
const core = require("../listening-intelligence.js");

const S = 1000;
const at = (day, h, m = 0, month = 10) => new Date(2026, month, day, h, m).getTime();
const NOW = at(14, 17, 30); // sábado 14-nov-2026 17:30
const rec = (uri, startedAt) => ({ id: `${startedAt}-${uri}`, uri, kind: "track", title: "t", artists: [{ uri: null, name: "X" }],
  contextUri: null, shuffle: "off", startedAt, endedAt: startedAt + 60 * S, playedMs: 60 * S, durationMs: 200 * S });

function inTZ(tz, fn) {
  const old = process.env.TZ;
  process.env.TZ = tz;
  try { fn(); } finally { if (old === undefined) delete process.env.TZ; else process.env.TZ = old; }
}

test("trend: % para cantidades, puntos para tasas, segundos para paciencia", () => {
  assert.equal(core.trend(118, 100, "count"), "▲ 18 %");
  assert.equal(core.trend(80, 100, "count"), "▼ 20 %");
  assert.equal(core.trend(100.4, 100, "count"), "= igual"); // redondea a 0
  assert.equal(core.trend(0.25, 0.2, "rate"), "▲ 5 pts"); // 20 % → 25 % son 5 puntos, no «+25 %»
  assert.equal(core.trend(0.2, 0.25, "rate"), "▼ 5 pts");
  assert.equal(core.trend(7200, 6000, "sec"), "▲ 1,2 s");
  assert.equal(core.trend(6050, 6000, "sec"), "= igual");
});

test("trend: sin con qué comparar → null (nunca dividir entre 0)", () => {
  assert.equal(core.trend(5, 0, "count"), null);
  assert.equal(core.trend(0, 0, "count"), null);
  assert.equal(core.trend(null, 0.2, "rate"), null);
  assert.equal(core.trend(0.2, null, "rate"), null);
});

test("previousWindow: mismo tramo, cortado a la misma hora del reloj", () => {
  const store = { observingSince: at(1, 0), records: [rec("a", at(13, 10)), rec("b", at(13, 18)), rec("c", at(14, 9))] };
  const w = core.previousWindow(store, "today", NOW);
  assert.equal(w.now, at(13, 17, 30)); // ayer a esta hora
  assert.deepEqual(w.records.map((r) => r.uri), ["a"]); // la de ayer a las 18:00 aún no había pasado; la de hoy tampoco
  assert.equal(core.aggregate(w.records, "today", w.now).valid, 1);
  assert.equal(core.previousWindow(store, "7d", NOW).now, at(7, 17, 30));
  // Justo en prevNow: fuera (el periodo anterior es startedAt < prevNow)
  const edge = { observingSince: at(1, 0), records: [rec("e", at(13, 17, 30))] };
  assert.equal(core.previousWindow(edge, "today", NOW).records.length, 0);
});

test("previousWindow: null si el periodo anterior no se observó entero", () => {
  const store = { observingSince: at(12, 15), records: [] };
  assert.ok(core.previousWindow(store, "today", NOW)); // ayer 00:00 ≥ jueves 15:00: observado entero
  assert.equal(core.previousWindow(store, "7d", NOW), null); // empezaría el sáb 1… antes de observar
  assert.equal(core.previousWindow({ observingSince: at(13, 0), records: [] }, "today", NOW) !== null, true); // justo a medianoche: vale
  assert.equal(core.previousWindow({ observingSince: at(13, 0, 1), records: [] }, "today", NOW), null);
});

test("previousWindow: el cambio de hora no mueve la hora del reloj (Madrid, 25-oct-2026)", () => inTZ("Europe/Madrid", () => {
  const t = (day, h, month) => new Date(2026, month, day, h).getTime(); // recalculado en Madrid
  const store = { observingSince: 0, records: [] };
  assert.equal(core.previousWindow(store, "7d", t(31, 10, 9)).now, t(24, 10, 9)); // semana con un día de 25 h
  assert.equal(core.previousWindow(store, "today", t(26, 10, 9)).now, t(25, 10, 9));
}));

test("trend: «1 pt» en singular (revisión final, minor)", () => {
  assert.equal(core.trend(0.51, 0.5, "rate"), "▲ 1 pt");
  assert.equal(core.trend(0.48, 0.5, "rate"), "▼ 2 pts");
});
