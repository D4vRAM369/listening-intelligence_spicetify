// Tests de la pestaña «Limpieza» (A1). Diseño: docs/informes/2026-11-14-diseno-limpieza.md
const test = require("node:test");
const assert = require("node:assert/strict");
const core = require("../listening-intelligence.js");

const S = 1000;
const DAY = 86400 * S;
const NOW = new Date(2026, 10, 14, 12).getTime(); // sábado 14-nov-2026 12:00 local
let seq = 0;
// playedS ≥ 30 → válida; 5 → saltada (duración 200 s)
function rec(uri, startedAt, playedS, contextUri = null) {
  seq += 1;
  return { id: `${startedAt}-${uri}-${seq}`, uri, kind: core.kindOf(uri), title: uri.split(":").pop(),
    artists: [{ uri: "spotify:artist:x", name: "X" }], contextUri, startedAt,
    endedAt: startedAt + playedS * S, playedMs: playedS * S, durationMs: 200 * S };
}
const times = (n, f) => Array.from({ length: n }, (_, i) => f(i));

const history = [
  ...times(4, (i) => rec("spotify:track:S", NOW - (i + 1) * DAY, 5)), // S: 4 saltos, 0 válidas
  ...times(3, (i) => rec("spotify:track:T", NOW - (i + 1) * DAY, 5)), // T: 3 saltos…
  rec("spotify:track:T", NOW - 5 * DAY, 60), // …y 1 válida → no se la acusa
  ...times(6, (i) => rec("spotify:track:M", NOW - (40 + i) * DAY, 60)), // M: 6 válidas, última hace 40 d
  ...times(5, (i) => rec("spotify:track:N", NOW - (30 + i) * DAY, 60)), // N: última hace 30 d justos
  ...times(6, (i) => rec(`spotify:track:Q${i}`, NOW - DAY, 5, "spotify:playlist:p1")), // p1: 6 saltadas…
  ...times(4, (i) => rec(`spotify:track:R${i}`, NOW - DAY, 60, "spotify:playlist:p1")), // …de 10
  ...times(9, (i) => rec(`spotify:track:V${i}`, NOW - DAY, 5, "spotify:playlist:p2")), // p2: solo 9
  ...times(20, (i) => rec(`spotify:track:W${i}`, NOW - DAY, 5, "spotify:album:x")), // álbum: no es playlist
  ...times(5, () => rec("spotify:episode:E", NOW - DAY, 5, "spotify:playlist:p3")), // episodio: fuera de todo
];

test("siempre las saltas: ≥3 saltos y 0 válidas (no acusa con una válida)", () => {
  const { alwaysSkipped } = core.cleanup(history, NOW);
  assert.deepEqual(alwaysSkipped.map((t) => [t.uri, t.skips]), [["spotify:track:S", 4]]);
  assert.equal(alwaysSkipped[0].name, "S");
  assert.equal(alwaysSkipped[0].artists, "X");
});

test("echas de menos: ≥5 válidas y la última hace MÁS de 30 días", () => {
  const { missed } = core.cleanup(history, NOW);
  assert.deepEqual(missed.map((t) => [t.uri, t.valid]), [["spotify:track:M", 6]]);
  assert.equal(missed[0].lastAt, NOW - 40 * DAY);
});

test("playlists: solo spotify:playlist: con ≥10 escuchas; episodios fuera", () => {
  const { playlists } = core.cleanup(history, NOW);
  assert.deepEqual(playlists, [{ uri: "spotify:playlist:p1", plays: 10, skipped: 6, rate: 0.6 }]);
});

test("listas cortadas en 10 y ordenadas de más a menos", () => {
  const many = times(12, (i) => times(3 + i, (k) => rec(`spotify:track:K${i}`, NOW - (k + 1) * DAY, 5))).flat();
  const { alwaysSkipped } = core.cleanup(many, NOW);
  assert.equal(alwaysSkipped.length, 10);
  assert.equal(alwaysSkipped[0].skips, 14);
  assert.equal(alwaysSkipped[9].skips, 5);
});

test("sin historial: tres listas vacías", () => {
  assert.deepEqual(core.cleanup([], NOW), { alwaysSkipped: [], missed: [], playlists: [] });
});
