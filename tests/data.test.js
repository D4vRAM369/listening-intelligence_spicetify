// Tests de exportar, importar y borrar (Paso 9). Ejecutar: node --test tests/
const test = require("node:test");
const assert = require("node:assert/strict");
const core = require("../listening-intelligence.js");

const S = 1000;
const NOW = new Date(2026, 10, 14, 12).getTime();
function rec(id, startedAt, playedS = 60) {
  return { id, uri: `spotify:track:${id}`, kind: "track", title: id, artists: [{ uri: "spotify:artist:x", name: "X" }],
    startedAt, endedAt: startedAt + playedS * S, playedMs: playedS * S, durationMs: 200 * S };
}
const store = (records, observingSince = records[0]?.startedAt ?? NOW) => ({ schemaVersion: 1, observingSince, open: null, records });

test("serialize: JSON legible por parseStore, sin la pista abierta", () => {
  const s = { ...store([rec("a", NOW - 3600 * S)]), open: { uri: "spotify:track:z" } };
  const r = core.parseStore(core.serialize(s), NOW);
  assert.equal(r.corrupt, false);
  assert.equal(r.store.open, null);
  assert.deepEqual(r.store.records, s.records);
});

test("mergeStores: une por id sin duplicar y ordena por fecha (RF-10)", () => {
  const a = rec("a", NOW - 3 * 3600 * S), b = rec("b", NOW - 2 * 3600 * S), c = rec("c", NOW - 5 * 3600 * S);
  const { store: m, added } = core.mergeStores(store([a, b]), store([b, c], c.startedAt));
  assert.equal(added, 1); // solo c es nueva; b ya estaba
  assert.deepEqual(m.records.map((r) => r.id), ["c", "a", "b"]);
  assert.equal(m.observingSince, c.startedAt); // lo importado amplía «observando desde»
});

test("mergeStores: importar dos veces el mismo archivo no cambia nada (idempotente)", () => {
  const imp = store([rec("a", NOW - 3600 * S)]);
  const once = core.mergeStores(store([]), imp).store;
  const twice = core.mergeStores(once, imp);
  assert.equal(twice.added, 0);
  assert.deepEqual(twice.store, once);
});

test("CA-05: exportar → borrar → importar = mismas métricas", () => {
  const original = store([rec("a", NOW - 3600 * S, 120), rec("b", NOW - 2 * 86400 * S, 10), rec("c", NOW - 10 * 86400 * S, 45)]);
  const file = core.serialize(original); // exportar
  const wiped = core.emptyStore(NOW); // borrar
  const imported = core.mergeStores(wiped, core.parseStore(file, NOW).store).store; // importar
  for (const range of ["today", "7d", "30d"]) {
    assert.deepEqual(core.aggregate(imported.records, range, NOW), core.aggregate(original.records, range, NOW), range);
  }
});

test("ownKeys: solo claves con nuestro prefijo (RF-11, CA-06)", () => {
  const keys = ["listening-intelligence:v1:store", "listening-intelligence:backup:5", "vibemusic:x", "marketplace:installed", "listening-intelligenceX"];
  assert.deepEqual(core.ownKeys(keys), ["listening-intelligence:v1:store", "listening-intelligence:backup:5"]);
});
