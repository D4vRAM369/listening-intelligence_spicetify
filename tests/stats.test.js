// Tests de agregación (Paso 7). Cifras calculadas a mano en docs/03_PASO_A_PASO.md § Paso 7.
// Las fechas se crean en hora LOCAL (new Date(año, mes, día, h, min)), así el test no depende de la zona horaria.
const test = require("node:test");
const assert = require("node:assert/strict");
const core = require("../listening-intelligence.js");

const S = 1000;
const at = (d, h, m = 0) => new Date(2026, d.month ?? 10, d.day, h, m).getTime(); // mes 10 = noviembre
const X = { uri: "spotify:artist:X", name: "X" };
const Y = { uri: "spotify:artist:Y", name: "Y" };
const Z = { uri: "spotify:artist:Z", name: "Z" };

function rec(uri, artists, startedAt, playedS, durationS) {
  return { id: `${startedAt}-${uri}`, uri, kind: core.kindOf(uri), title: uri.slice(-1), artists,
    startedAt, endedAt: startedAt + playedS * S, playedMs: playedS * S, durationMs: durationS * S };
}

// «Ahora» = sábado 14-nov-2026 12:00 hora local.
const NOW = at({ day: 14 }, 12);
const records = [
  rec("spotify:track:A", [X], at({ day: 14 }, 10), 200, 200), // r1 hoy, válida
  rec("spotify:track:A", [X], at({ day: 14 }, 11), 40, 200), // r2 hoy, válida (regla 30 s)
  rec("spotify:track:B", [Y], at({ day: 14 }, 11, 30), 5, 180), // r3 hoy, saltada
  rec("spotify:episode:P", [], at({ day: 14 }, 9), 600, 3600), // r4 episodio: fuera de las métricas (Q-02)
  rec("spotify:track:C", [Y, X], at({ day: 8 }, 23, 50), 180, 180), // r5 domingo 23:50, borde de 7 días
  rec("spotify:track:D", [Z], at({ day: 7 }, 23, 59), 100, 200), // r6 sábado anterior: fuera de 7 d, dentro de 30 d
  rec("spotify:track:E", [Z], at({ day: 5, month: 9 }, 12), 300, 300), // r7 hace 40 días: fuera de todo
];

test("rangeStart: días naturales en hora local (RF-06)", () => {
  assert.equal(core.rangeStart("today", NOW), at({ day: 14 }, 0));
  assert.equal(core.rangeStart("7d", NOW), at({ day: 8 }, 0)); // hoy + 6 días anteriores
  assert.equal(core.rangeStart("30d", NOW), at({ day: 16, month: 9 }, 0));
});

test("hoy: minutos, válidas, saltadas y tops (RF-07, Q-02)", () => {
  const s = core.aggregate(records, "today", NOW);
  assert.equal(s.listenedMs, 245 * S); // 200 + 40 + 5; el episodio no cuenta
  assert.equal(s.valid, 2);
  assert.equal(s.skipped, 1);
  assert.deepEqual(s.topArtists.map((a) => [a.name, a.count]), [["X", 2]]); // Y solo tiene una saltada
  assert.deepEqual(s.topTracks.map((t) => [t.uri, t.count]), [["spotify:track:A", 2]]);
});

test("7 días: incluye el domingo 23:50 y lo reparte bien (RF-06, RF-08)", () => {
  const s = core.aggregate(records, "7d", NOW);
  assert.equal(s.listenedMs, 425 * S);
  assert.equal(s.valid, 3);
  assert.deepEqual(s.topArtists.map((a) => [a.name, a.count]), [["X", 3], ["Y", 1]]);
  assert.equal(s.byHour[23], 1); // la escucha de las 23:50 cae en «23 h»
  assert.equal(s.byWeekday[6], 1); // …y en domingo (0 = lunes … 6 = domingo)
  assert.equal(s.byWeekday[5], 2); // sábado: r1 y r2
  assert.equal(s.byHour.length, 24);
  assert.equal(s.byWeekday.length, 7);
});

test("30 días: empates se deshacen por tiempo escuchado; lo antiguo queda fuera", () => {
  const s = core.aggregate(records, "30d", NOW);
  assert.equal(s.listenedMs, 525 * S); // r7 (40 días) fuera
  assert.equal(s.valid, 4);
  assert.deepEqual(s.topArtists.map((a) => [a.name, a.count]), [["X", 3], ["Y", 1], ["Z", 1]]); // Y 180 s > Z 100 s
  assert.deepEqual(s.topTracks.map((t) => t.uri), ["spotify:track:A", "spotify:track:C", "spotify:track:D"]);
  assert.equal(s.byHour[23], 2);
});

test("sin datos: todo a cero, sin romper", () => {
  const s = core.aggregate([], "7d", NOW);
  assert.equal(s.listenedMs, 0);
  assert.equal(s.valid, 0);
  assert.deepEqual(s.topArtists, []);
  assert.equal(s.byHour.reduce((a, b) => a + b), 0);
});

test("top limitado a 5", () => {
  const many = "ABCDEFG".split("").map((k, i) => rec(`spotify:track:${k}`, [{ uri: `spotify:artist:${k}`, name: k }], at({ day: 14 }, 1, i), 60, 200));
  const s = core.aggregate(many, "today", NOW);
  assert.equal(s.topArtists.length, 5);
  assert.equal(s.topTracks.length, 5);
});

// Recuerdos (D-024): intervalo [from, to) explícito, cortado por los dos lados.
test("aggregateBetween corta por ambos lados", () => {
  const rs = [1, 2, 3].map((day) => rec(`spotify:track:${day}`, [X], at({ day }, 10), 120, 200));
  const out = core.aggregateBetween(rs, at({ day: 2 }, 0), at({ day: 3 }, 0));
  assert.equal(out.valid, 1);
  assert.equal(out.topTracks[0].uri, "spotify:track:2");
});
