// Tests de la lógica pura de Listening Intelligence. Ejecutar: node --test tests/
const test = require("node:test");
const assert = require("node:assert/strict");
const core = require("../listening-intelligence.js");

const S = 1000; // 1 segundo en ms

// PlayerState mínimo con la forma observada en el Paso 4.
function state(uri, { isPaused = false, duration = 200 * S, shuffle = false, smartShuffle = false } = {}) {
  return {
    item: { uri, name: uri.slice(-1), type: "track", artists: [{ uri: "spotify:artist:x", name: "X" }], album: { uri: "spotify:album:1" } },
    duration, isPaused, shuffle, smartShuffle, context: { uri: "spotify:playlist:p" },
  };
}

// Aplica una lista de [instante, estado] y devuelve la pista abierta y los registros cerrados.
function run(steps) {
  let open = null;
  const closed = [];
  for (const [t, st] of steps) {
    const r = core.applyState(open, st, t);
    open = r.open;
    if (r.closed) closed.push(r.closed);
  }
  return { open, closed };
}

test("pausar y reanudar no cuenta el tiempo en pausa (RF-02, CA-01)", () => {
  const { closed } = run([
    [0, state("spotify:track:A")],
    [20 * S, state("spotify:track:A", { isPaused: true })], // 20 s sonando
    [320 * S, state("spotify:track:A")], // 5 min en pausa: no cuentan
    [335 * S, state("spotify:track:B")], // +15 s → total 35 s
  ]);
  assert.equal(closed.length, 1);
  assert.equal(closed[0].playedMs, 35 * S);
  assert.equal(closed[0].pauses, 1);
});

test("songchange + onplaypause gemelos no duplican (D-012)", () => {
  const a = state("spotify:track:A");
  const { open } = run([[0, a], [0, a], [10 * S, a], [10 * S, a]]);
  assert.equal(open.playedMs, 10 * S);
});

test("pista restaurada en pausa al arrancar y nunca reproducida → no se registra (D-012, D-013)", () => {
  const { closed, open } = run([
    [0, state("spotify:track:A", { isPaused: true })],
    [17 * S, state("spotify:track:B")],
  ]);
  assert.equal(closed.length, 0);
  assert.equal(open.uri, "spotify:track:B");
});

test("bucle: sin songchange, un único registro que suma todas las vueltas (D-007)", () => {
  const a = state("spotify:track:A", { duration: 195 * S });
  const { open } = run([[0, a], [400 * S, a]]); // solo un latido: Spotify no avisa del bucle
  assert.equal(open.playedMs, 400 * S);
  const rec = core.closeRecord(open, 400 * S);
  assert.ok(rec.playedMs > rec.durationMs); // playedMs > duración es legítimo
  assert.ok(core.isValidRecord(rec));
});

test("contextUri y shuffle se guardan (D-011)", () => {
  const r = core.openRecord(state("spotify:track:A", { shuffle: true, smartShuffle: true }), 0);
  assert.equal(r.contextUri, "spotify:playlist:p");
  assert.equal(r.shuffle, "smart");
  assert.equal(core.shuffleMode({ shuffle: true, smartShuffle: false }), "on");
  assert.equal(core.shuffleMode({ shuffle: false, smartShuffle: false }), "off");
});

test("estado sin URI se ignora sin romper (Q-03)", () => {
  assert.equal(core.openRecord(null, 0), null);
  assert.equal(core.openRecord({ item: {} }, 0), null);
  const { open, closed } = run([[0, state("spotify:track:A")], [40 * S, null]]);
  assert.equal(open, null);
  assert.equal(closed[0].playedMs, 40 * S);
});

test("kind distingue pista, episodio y local (Q-02)", () => {
  assert.equal(core.kindOf("spotify:track:x"), "track");
  assert.equal(core.kindOf("spotify:episode:x"), "episode");
  assert.equal(core.kindOf("spotify:local:a:b:c:1"), "local");
});

test("recuperación tras cierre brusco usa el último checkpoint (RF-03)", () => {
  let open = core.openRecord(state("spotify:track:A"), 0);
  open = core.flush(open, 45 * S); // checkpoint a los 45 s; luego Spotify muere
  const rec = core.recoverOpen(open);
  assert.equal(rec.playedMs, 45 * S);
  assert.equal(rec.endedAt, 45 * S);
  assert.ok(core.isValidRecord(rec));
});

test("isValidRecord rechaza registros imposibles (RF-12)", () => {
  const ok = core.closeRecord(core.openRecord(state("spotify:track:A"), 0), 60 * S);
  assert.ok(core.isValidRecord(ok));
  assert.ok(!core.isValidRecord({ ...ok, playedMs: 120 * S })); // sonó más de lo que pasó
  assert.ok(!core.isValidRecord({ ...ok, endedAt: -1 }));
  assert.ok(!core.isValidRecord({ ...ok, uri: "track:A" }));
  assert.ok(!core.isValidRecord({ ...ok, playedMs: NaN }));
  assert.ok(!core.isValidRecord(null));
});

test("parseStore: vacío, corrupto, versión ajena y registros inválidos (RF-05, RF-12)", () => {
  const first = core.parseStore(null, 5);
  assert.deepEqual(first, { store: core.emptyStore(5), dropped: 0, corrupt: false });

  assert.equal(core.parseStore("{no es json", 5).corrupt, true);
  assert.equal(core.parseStore(JSON.stringify({ schemaVersion: 99, records: [] }), 5).corrupt, true);

  const good = core.closeRecord(core.openRecord(state("spotify:track:A"), 0), 60 * S);
  const raw = JSON.stringify({ schemaVersion: 1, observingSince: 0, open: null, records: [good, { basura: true }, { ...good, playedMs: -1 }] });
  const r = core.parseStore(raw, 5);
  assert.equal(r.corrupt, false);
  assert.equal(r.dropped, 2);
  assert.deepEqual(r.store.records, [good]);
  assert.equal(r.store.observingSince, 0);
});

test("tamaño por registro (Q-04)", () => {
  const rec = core.closeRecord(
    core.openRecord(
      {
        ...state("spotify:track:7oxwhQxkGegjlMf3k9sWgm", { shuffle: true }),
        item: { uri: "spotify:track:7oxwhQxkGegjlMf3k9sWgm", name: "Un título de canción de longitud media", artists: [{ uri: "spotify:artist:3pO5VjZ4wOHCMBXOvbMISG", name: "Nombre de artista" }], album: { uri: "spotify:album:7LAyThhW5nCJbjSRbQX0U1" } },
        context: { uri: "spotify:playlist:37i9dQZF1F5p3rmiWPIYgZ" },
      },
      1763142000000
    ),
    1763142254000
  );
  const bytes = JSON.stringify(rec).length;
  console.log(`  bytes por registro ≈ ${bytes} → ~${Math.floor((5 * 1024 * 1024) / bytes)} registros en 5 MB`);
  assert.ok(bytes < 600);
});

test("classify: umbral 30 s o 50 %, lo que llegue antes (RF-04, D-004)", () => {
  const c = core.classify;
  // Regla de 30 s, canción larga (180 s): el 50 % serían 90 s, así que manda la regla de 30 s
  assert.equal(c(29_999, 180 * S), "skipped");
  assert.equal(c(30_000, 180 * S), "valid"); // justo en el umbral → válida (≥)
  assert.equal(c(10 * S, 180 * S), "skipped");
  // Regla del 50 %, canción corta (40 s): 20 s bastan
  assert.equal(c(19_999, 40 * S), "skipped");
  assert.equal(c(20_000, 40 * S), "valid");
  // Duración desconocida (0): solo cuenta la regla de 30 s
  assert.equal(c(29_999, 0), "skipped");
  assert.equal(c(30_000, 0), "valid");
  // Bucle: playedMs > duración → válida (D-007)
  assert.equal(c(400 * S, 195 * S), "valid");
});

test("cambiar rápido de pista no convierte todo en válidas (CA-02)", () => {
  const steps = [];
  for (let i = 0; i < 10; i++) steps.push([i * 5 * S, state(`spotify:track:${i}`)]); // 5 s cada una
  const { closed } = run(steps);
  assert.equal(closed.length, 9);
  assert.ok(closed.every((r) => core.classify(r.playedMs, r.durationMs) === "skipped"));
});

test("isValidRecord exige title y nombres de artista como texto (RF-12, revisión final A1)", () => {
  const ok = core.closeRecord(core.openRecord(state("spotify:track:A"), 0), 60 * S);
  assert.ok(!core.isValidRecord({ ...ok, title: undefined })); // sin título: localeCompare rompería el panel
  assert.ok(!core.isValidRecord({ ...ok, title: 5 }));
  assert.ok(!core.isValidRecord({ ...ok, artists: [null] })); // a.name sobre null rompería aggregate
  assert.ok(!core.isValidRecord({ ...ok, artists: [{ uri: null, name: 7 }] }));
  assert.ok(core.isValidRecord({ ...ok, title: "" })); // título vacío es legítimo (openRecord lo usa de respaldo)
});
