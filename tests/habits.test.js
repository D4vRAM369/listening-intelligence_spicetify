// Tests de «Cómo escuchas» (C). Diseño: docs/informes/2026-11-14-diseno-como-escuchas.md
const test = require("node:test");
const assert = require("node:assert/strict");
const core = require("../listening-intelligence.js");

const S = 1000;
const at = (day, h, m = 0) => new Date(2026, 10, day, h, m).getTime();
const NOW = at(14, 12); // sábado 14-nov-2026 12:00

function rec(uri, startedAt, playedS, { shuffle = "off", ctx = null, durS = 200 } = {}) {
  return { id: `${startedAt}-${uri}`, uri, kind: core.kindOf(uri), title: uri.slice(-2), artists: [{ uri: null, name: "X" }],
    contextUri: ctx, shuffle, startedAt, endedAt: startedAt + playedS * S, playedMs: playedS * S, durationMs: durS * S };
}

// 20 escuchas del sábado: 8 enteras, 4 a medias, 8 saltadas (2…16 s)
const CTX = [...Array(10).fill("spotify:playlist:p"), ...Array(6).fill("spotify:album:a"), "spotify:artist:x", "spotify:artist:x", "spotify:track:t", null];
function sample({ c7 = 200 } = {}) {
  const items = [
    ...Array.from({ length: 8 }, (_, i) => [`c${i}`, i === 7 ? c7 : 200, i < 4 ? "on" : "off"]),
    ...Array.from({ length: 4 }, (_, i) => [`p${i}`, 60, "off"]),
    ...Array.from({ length: 8 }, (_, i) => [`s${i}`, 2 * (i + 1), i < 6 ? "on" : "off"]),
  ];
  const inRange = items.map(([k, played, shuffle], i) => rec(`spotify:track:${k}`, at(14, 8, i * 5), played, { shuffle, ctx: CTX[i] }));
  // Historial anterior (fuera de 7 días): c0…c7 y p0 ya escuchadas → 9 de 12 válidas son repeticiones
  const before = ["c0", "c1", "c2", "c3", "c4", "c5", "c6", "c7", "p0"].map((k, i) => rec(`spotify:track:${k}`, at(1, 10, i), 120));
  return [...before, ...inRange, rec("spotify:episode:e", at(14, 11), 5)]; // el episodio no cuenta
}

test("habits: métricas calculadas a mano (C)", () => {
  const h = core.habits(sample(), "7d", NOW);
  assert.equal(h.n, 20);
  assert.equal(h.enough, true);
  assert.equal(h.completed, 8);
  assert.equal(h.partial, 4);
  assert.equal(h.skipped, 8);
  assert.ok(Math.abs(h.attention - 0.478) < 1e-9); // (8·1 + 4·0,3 + 72/200) / 20
  assert.equal(h.patienceMs, 9000); // mediana par: (8 s + 10 s) / 2
  assert.deepEqual(h.shuffleSkip, { on: 0.6, off: 0.2 });
  assert.equal(h.repeatShare, 0.75);
  assert.deepEqual(h.sources, { playlist: 10, album: 6, artist: 2, track: 1, other: 1 });
  assert.deepEqual(h.badges.map((b) => b.id), ["fastSkip", "repeat", "shuffleBored"]);
  assert.ok(h.badges.every((b) => typeof b.label === "string" && b.rule.length > 0)); // cada insignia explica su regla
});

test("habits: 19 escuchas → aviso; 20 → análisis", () => {
  const all = sample();
  const lastS = all.findLast((r) => r.uri === "spotify:track:s7");
  const h19 = core.habits(all.filter((r) => r !== lastS), "7d", NOW);
  assert.deepEqual({ n: h19.n, enough: h19.enough }, { n: 19, enough: false });
  assert.equal(core.habits(all, "7d", NOW).enough, true);
});

test("habits: 90 % justo es «completa»; un milisegundo menos, «a medias»", () => {
  assert.equal(core.habits(sample({ c7: 180 }), "7d", NOW).completed, 8);
  assert.equal(core.habits(sample({ c7: 179.999 }), "7d", NOW).completed, 7);
});

test("habits: sin escuchas con aleatorio → null y sin insignia 🎲", () => {
  const off = sample().map((r) => ({ ...r, shuffle: "off" }));
  const h = core.habits(off, "7d", NOW);
  assert.equal(h.shuffleSkip.on, null);
  assert.ok(!h.badges.some((b) => b.id === "shuffleBored"));
});

test("habits: primera vez dentro del rango no es repetición", () => {
  const noHistory = sample().filter((r) => r.startedAt >= at(14, 0)); // sin el historial del 1-nov
  assert.equal(core.habits(noHistory, "7d", NOW).repeatShare, 0);
});

test("la cifra de la insignia ⏭ no contradice su regla (9,6 s no se redondea a 10 s; revisión final C)", () => {
  const data = sample().map((r) => (r.uri === "spotify:track:s4" ? { ...r, playedMs: 11_200 } : r)); // mediana (8 + 11,2) / 2 = 9,6 s
  const h = core.habits(data, "7d", NOW);
  assert.equal(h.patienceMs, 9600);
  const fast = h.badges.find((b) => b.id === "fastSkip");
  assert.match(fast.rule, /a los 9,6 s/);
  assert.equal(core.fmtSec(9_999), "9,9 s"); // se trunca, no se redondea: nunca «10 s» por debajo de 10
  assert.equal(core.fmtSec(9_000), "9 s");
});
