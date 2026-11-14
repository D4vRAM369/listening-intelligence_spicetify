// Tests de «Recuerdos» (D-024). Diseño: docs/informes/2026-11-14-diseno-recuerdos.md
// Fechas en hora LOCAL (new Date(año, mes, día, h)): el test no depende de la zona horaria salvo en inTZ.
const test = require("node:test");
const assert = require("node:assert/strict");
const core = require("../listening-intelligence.js");

const S = 1000;
const DAY = 86400 * S;
const at = (y, mo, d, h = 12) => new Date(y, mo, d, h).getTime(); // mo: 0 = enero
// Escucha válida de 60 s a una hora dada.
const rec = (uri, startedAt, playedS = 60) => ({ id: `${startedAt}-${uri}`, uri, kind: "track", title: uri.slice(-2),
  artists: [{ uri: "spotify:artist:x", name: "X" }], contextUri: null, shuffle: "off", startedAt,
  endedAt: startedAt + playedS * S, playedMs: playedS * S, durationMs: 200 * S });
const OBS = at(2026, 0, 1, 0); // observando desde el 1-ene-2026

function inTZ(tz, fn) {
  const old = process.env.TZ;
  process.env.TZ = tz;
  try { fn(); } finally { if (old === undefined) delete process.env.TZ; else process.env.TZ = old; }
}

test("dayRange: días naturales completos y orden corregido si llegan al revés", () => {
  const a = core.dayRange("2026-11-01", "2026-11-03");
  assert.deepEqual(core.dayRange("2026-11-03", "2026-11-01"), a);
  assert.equal(a.from, at(2026, 10, 1, 0));
  assert.equal(a.to, at(2026, 10, 4, 0)); // 00:00 del día SIGUIENTE al último: el 3 entra entero
});

test("slot: franjas del día", () => {
  assert.equal(core.slot(5), "madrugada");
  assert.equal(core.slot(6), "mañana");
  assert.equal(core.slot(19), "tarde");
  assert.equal(core.slot(20), "noche");
});

test("shortcut: último verano TERMINADO, mes hace un año, seis meses y todo", () => {
  assert.deepEqual(core.shortcut("lastSummer", at(2026, 10, 14)), { from: "2026-06-21", to: "2026-09-22" });
  assert.deepEqual(core.shortcut("lastSummer", at(2027, 4, 1)), { from: "2026-06-21", to: "2026-09-22" });
  assert.deepEqual(core.shortcut("yearAgoMonth", at(2026, 10, 14)), { from: "2025-11-01", to: "2025-11-30" });
  assert.deepEqual(core.shortcut("sixMonths", at(2026, 10, 14)), { from: "2026-05-14", to: "2026-11-14" });
  assert.deepEqual(core.shortcut("all", at(2026, 10, 14), at(2026, 10, 2, 9)), { from: "2026-11-02", to: "2026-11-14" });
});

test("memories: la canción del periodo, con su franja", () => {
  const rs = [rec("spotify:track:AA", at(2026, 5, 10, 22)), rec("spotify:track:AA", at(2026, 5, 11, 23)), rec("spotify:track:BB", at(2026, 5, 10, 9))];
  const { from, to } = core.dayRange("2026-06-01", "2026-06-30");
  const m = core.memories(rs, from, to, OBS);
  assert.equal(m.song.uri, "spotify:track:AA");
  assert.equal(m.song.slot, "noche");
  assert.equal(m.song.count, 2);
});

test("memories: lo escuchado por primera vez ANTES del rango no es un descubrimiento", () => {
  const rs = [rec("spotify:track:OL", at(2026, 2, 1)), rec("spotify:track:OL", at(2026, 5, 10)), rec("spotify:track:NE", at(2026, 5, 12))];
  const { from, to } = core.dayRange("2026-06-01", "2026-06-30");
  const m = core.memories(rs, from, to, OBS);
  assert.deepEqual(m.discoveries.map((d) => d.uri), ["spotify:track:NE"]);
  assert.equal(m.discoveriesTitle, "Descubriste en ese periodo");
});

test("memories: un saltado no cuenta como primera escucha (la primera es la primera VÁLIDA)", () => {
  const rs = [rec("spotify:track:SK", at(2026, 2, 1), 5), rec("spotify:track:SK", at(2026, 5, 10))];
  const { from, to } = core.dayRange("2026-06-01", "2026-06-30");
  assert.deepEqual(core.memories(rs, from, to, OBS).discoveries.map((d) => d.uri), ["spotify:track:SK"]);
});

test("memories: los primeros 30 días de observación se titulan «Nuevas desde que se observa»", () => {
  const { from, to } = core.dayRange("2026-01-05", "2026-01-20");
  assert.equal(core.memories([], from, to, OBS).discoveriesTitle, "Nuevas desde que se observa");
});

test("memories: un día por día natural, también los vacíos", () => {
  const rs = [rec("spotify:track:AA", at(2026, 5, 1)), rec("spotify:track:AA", at(2026, 5, 3))];
  const { from, to } = core.dayRange("2026-06-01", "2026-06-03");
  const m = core.memories(rs, from, to, OBS);
  assert.equal(m.days.length, 3);
  assert.equal(m.days[1].ms, 0);
  assert.equal(m.days[0].ms, 60 * S);
});

test("memories: la cola tiene como mucho 50 pistas distintas, por escuchas", () => {
  const rs = [];
  for (let i = 0; i < 60; i++) rs.push(rec(`spotify:track:${String(i).padStart(2, "0")}`, at(2026, 5, 10) + i * 120 * S));
  rs.push(rec("spotify:track:59", at(2026, 5, 11))); // la 59 suena dos veces → primera de la cola
  const { from, to } = core.dayRange("2026-06-01", "2026-06-30");
  const q = core.memories(rs, from, to, OBS).queue;
  assert.equal(q.length, 50);
  assert.equal(q[0], "spotify:track:59");
  assert.equal(new Set(q).size, 50);
});

test("memories: un rango anterior a la observación se recorta y lo dice", () => {
  const { from, to } = core.dayRange("2025-12-01", "2026-01-10");
  const m = core.memories([], from, to, at(2026, 0, 1, 9));
  assert.equal(m.clippedFrom, at(2026, 0, 1, 0));
  assert.equal(m.days.length, 10); // del 1 al 10 de enero, ambos incluidos
});

test("memories: un cambio de hora no descuadra las barras (Europe/Madrid, 25-oct-2026)", () => {
  inTZ("Europe/Madrid", () => {
    const { from, to } = core.dayRange("2026-10-24", "2026-10-26");
    const m = core.memories([], from, to, OBS);
    assert.equal(m.days.length, 3);
    assert.equal(m.days[2].start - m.days[1].start, DAY + 3600 * S); // el 25 dura 25 h (se atrasa el reloj)
  });
});
