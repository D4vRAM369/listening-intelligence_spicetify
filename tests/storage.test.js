// Tests del almacenamiento a largo plazo (D-023). Diseño: docs/informes/2026-11-14-diseno-recuerdos.md
// combineSources es la parte PURA del arranque: decide qué hay que escribir en IndexedDB.
// La capa IndexedDB en sí no se puede probar en Node (no existe allí); se verifica en Spotify.
const test = require("node:test");
const assert = require("node:assert/strict");
const core = require("../listening-intelligence.js");

const S = 1000;
const NOW = new Date(2026, 10, 14, 18, 0).getTime();
const T0 = new Date(2026, 10, 14, 10, 0).getTime();
const rec = (n) => ({ id: `${T0 + n * 60 * S}-spotify:track:${n}`, uri: `spotify:track:${n}`, kind: "track", title: `t${n}`,
  artists: [{ uri: null, name: "X" }], contextUri: null, shuffle: "off", startedAt: T0 + n * 60 * S,
  endedAt: T0 + n * 60 * S + 50 * S, playedMs: 50 * S, durationMs: 200 * S });
const open = { uri: "spotify:track:99", kind: "track", title: "abierta", artists: [], startedAt: NOW - 10 * S, lastSeenAt: NOW, playedMs: 10 * S };
const lsText = (records, observingSince = T0) => JSON.stringify({ schemaVersion: 1, observingSince, open: null, records });
const empty = { idbRecords: [], idbMeta: null, lsRaw: null, pendingRaw: null };

test("combineSources: primera vez → store vacío, nada que escribir", () => {
  const out = core.combineSources(empty, NOW);
  assert.equal(out.store.records.length, 0);
  assert.equal(out.store.observingSince, NOW);
  assert.deepEqual(out.toPut, []);
  assert.equal(out.migrated, false);
});

test("combineSources: migración desde localStorage", () => {
  const out = core.combineSources({ ...empty, lsRaw: lsText([rec(1), rec(2), rec(3)], T0 - 1000) }, NOW);
  assert.equal(out.toPut.length, 3);
  assert.equal(out.migrated, true);
  assert.equal(out.store.observingSince, T0 - 1000);
});

test("combineSources: idempotente (la migración ya se hizo pero la clave antigua sigue ahí)", () => {
  const rs = [rec(1), rec(2), rec(3)];
  const out = core.combineSources({ ...empty, idbRecords: rs, idbMeta: { observingSince: T0 }, lsRaw: lsText(rs) }, NOW);
  assert.equal(out.toPut.length, 0);
  assert.equal(out.store.records.length, 3);
});

test("combineSources: lo pendiente del espejo se recupera (cierre brusco)", () => {
  const pendingRaw = JSON.stringify({ open, unsaved: [rec(5)] });
  const out = core.combineSources({ ...empty, idbRecords: [rec(1)], idbMeta: { observingSince: T0 }, pendingRaw }, NOW);
  assert.deepEqual(out.toPut.map((r) => r.id), [rec(5).id]);
  assert.deepEqual(out.store.records.map((r) => r.id), [rec(1).id, rec(5).id]);
  assert.deepEqual(out.store.open, open);
});

test("combineSources: observingSince = el menor de todas las fuentes", () => {
  const out = core.combineSources({ ...empty, idbRecords: [rec(1)], idbMeta: { observingSince: T0 + 90 * S }, lsRaw: lsText([], T0 + 99 * S) }, NOW);
  assert.equal(out.store.observingSince, rec(1).startedAt);
});

test("combineSources: espejo corrupto → se ignora sin lanzar", () => {
  const out = core.combineSources({ ...empty, idbRecords: [rec(1)], idbMeta: { observingSince: T0 }, pendingRaw: "{roto" }, NOW);
  assert.equal(out.store.records.length, 1);
  assert.equal(out.store.open, null);
});

test("pendingPayload: guarda la pista abierta y lo no confirmado", () => {
  const p = JSON.parse(core.pendingPayload({ open }, [rec(5)]));
  assert.deepEqual(p, { open, unsaved: [rec(5)] });
});

// Revisión final, I1: confirmar un lote NO puede llevarse un registro que no estaba en él.
test("dropConfirmed: quita solo lo confirmado, aunque otro lote ya lo hubiera quitado", () => {
  const [r1, r2, r3] = [rec(1), rec(2), rec(3)];
  assert.deepEqual(core.dropConfirmed([r2, r3], [r1, r2]).map((r) => r.id), [r3.id]); // r1 ya no estaba: r3 se queda
  assert.deepEqual(core.dropConfirmed([], [r1]), []);
});

// Parte 2 (D-023): sin copia automática posible en Spotify, el pie recuerda cuándo fue la última copia.
test("backupLine: cuándo fue la última copia, en días de calendario", () => {
  const now = new Date(2026, 10, 14, 18).getTime();
  assert.equal(core.backupLine(null, now), "Sin copia de seguridad todavía: usa Exportar");
  assert.equal(core.backupLine(new Date(2026, 10, 14, 9).getTime(), now), "Última copia: hoy");
  assert.equal(core.backupLine(new Date(2026, 10, 13, 23).getTime(), now), "Última copia: ayer");
  assert.equal(core.backupLine(new Date(2026, 10, 2, 12).getTime(), now), "Última copia: hace 12 días");
  assert.equal(core.backupLine(new Date(2026, 9, 20, 12).getTime(), new Date(2026, 9, 26, 12).getTime()), "Última copia: hace 6 días"); // cruza el cambio de hora
});
