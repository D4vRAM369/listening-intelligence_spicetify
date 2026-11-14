// Tests de «Tu semana sonora» (B): mapa de calor, sesiones y racha. Diseño: docs/informes/2026-11-14-diseno-semana-sonora.md
const test = require("node:test");
const assert = require("node:assert/strict");
const core = require("../listening-intelligence.js");

const S = 1000;
const at = (day, h, m = 0, month = 10) => new Date(2026, month, day, h, m).getTime(); // hora local; mes 10 = noviembre
const NOW = at(14, 12); // sábado 14-nov-2026 12:00
function rec(uri, startedAt, playedS) {
  return { id: `${startedAt}-${uri}`, uri, kind: core.kindOf(uri), title: "t", artists: [{ uri: null, name: "X" }],
    startedAt, endedAt: startedAt + playedS * S, playedMs: playedS * S, durationMs: 200 * S };
}
const records = [
  rec("spotify:track:r1", at(14, 10), 120), // termina 10:02
  rec("spotify:track:r2", at(14, 10, 22), 60), // hueco de 20 min justos → misma sesión
  rec("spotify:track:r3", at(14, 11), 5), // saltada, 37 min después → sesión nueva
  rec("spotify:track:r4", at(8, 23, 50), 180), // domingo 23:50
  rec("spotify:track:r5", at(7, 23, 59), 100), // sábado anterior: fuera de 7 días
  rec("spotify:episode:r6", at(14, 9), 600), // episodio: fuera de todo
];

test("heatmap: ms por día × hora de inicio, válidas y saltadas, sin episodios", () => {
  const m = core.heatmap(records, "7d", NOW);
  assert.equal(m.length, 7);
  assert.equal(m[0].length, 24);
  assert.equal(m[5][10], 180 * S); // sábado 10 h: r1 + r2
  assert.equal(m[5][11], 5 * S); // r3 saltada también suena
  assert.equal(m[6][23], 180 * S); // domingo 23 h
  assert.equal(m.flat().reduce((a, b) => a + b), 365 * S);
});

test("sessions: hueco ≤ 20 min = misma sesión", () => {
  assert.deepEqual(core.sessions(records, "7d", NOW), { count: 3, avgMs: 121667, maxMs: 180 * S });
  assert.deepEqual(core.sessions([], "7d", NOW), { count: 0, avgMs: 0, maxMs: 0 });
});

test("streak: actual (hoy o ayer) y récord, en días naturales", () => {
  assert.deepEqual(core.streak(records, NOW), { current: 1, best: 2 }); // hoy; récord sáb 7 + dom 8
  const yday = [rec("spotify:track:a", at(12, 20), 60), rec("spotify:track:b", at(13, 20), 60)];
  assert.equal(core.streak(yday, NOW).current, 2); // acabó ayer: sigue viva
  assert.deepEqual(core.streak([rec("spotify:track:a", at(12, 20), 60)], NOW), { current: 0, best: 1 }); // anteayer: rota
  assert.deepEqual(core.streak([rec("spotify:track:s", at(14, 10), 5)], NOW), { current: 0, best: 0 }); // solo saltadas: no cuentan
  assert.deepEqual(core.streak([], NOW), { current: 0, best: 0 });
});

// Fija la zona horaria durante un test (Node aplica el cambio de process.env.TZ al momento).
function inTZ(tz, fn) {
  const old = process.env.TZ;
  process.env.TZ = tz;
  try { fn(); } finally { if (old === undefined) delete process.env.TZ; else process.env.TZ = old; }
}

test("streak: cambio de hora a medianoche (Chile) no rompe la racha (revisión final B)", () => {
  inTZ("America/Santiago", () => {
    // 6-sep-2026: en Santiago el reloj salta de 00:00 a 01:00 → ese día no tiene 00:00
    const days = [4, 5, 6, 7].map((d) => rec(`spotify:track:${d}`, new Date(2026, 8, d, 12).getTime(), 60));
    assert.deepEqual(core.streak(days, new Date(2026, 8, 7, 18).getTime()), { current: 4, best: 4 });
  });
});

test("streak: el cambio de hora (día de 23 h) no rompe la racha", () => inTZ("Europe/Madrid", () => {
  const at = (day, h, m = 0, month = 10) => new Date(2026, month, day, h, m).getTime(); // recalculado en Madrid
  const dst = [28, 29, 30].map((d) => rec(`spotify:track:${d}`, at(d, 1, 30, 2), 60)); // 28-30 marzo 2026, 01:30
  assert.equal(core.streak(dst, at(30, 12, 0, 2)).best, 3);
  assert.equal(core.streak(dst, at(30, 12, 0, 2)).current, 3);
}));

test("fmtMin: «<1 min» si sonó algo pero menos de 30 s; «—» si nada (pulido B)", () => {
  assert.equal(core.fmtMin(0), "—");
  assert.equal(core.fmtMin(5 * S), "<1 min"); // celda coloreada no puede decir «0 min»
  assert.equal(core.fmtMin(29_999), "<1 min");
  assert.equal(core.fmtMin(30 * S), "1 min");
  assert.equal(core.fmtMin(75 * 60 * S), "1 h 15 min");
});
