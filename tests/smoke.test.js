// Prueba de extremo a extremo con Spicetify y LocalStorage simulados (mock) y reloj controlado.
// Simula: escuchar, pausar, cambiar de pista, cierre brusco de Spotify y nuevo arranque.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const path = require("node:path");

const SRC = fs.readFileSync(path.join(__dirname, "..", "listening-intelligence.js"), "utf8");
const S = 1000;

// DOM falso mínimo: lo justo que usa el panel (append, replaceChildren, click).
function fakeEl(tag) {
  return { tag, children: [], style: {}, textContent: "", title: "", disabled: false, listeners: {},
    append(...c) { this.children.push(...c); }, replaceChildren(...c) { this.children = c; },
    addEventListener(t, cb) { this.listeners[t] = cb; } };
}
const textOf = (n) => [n.textContent, ...n.children.map(textOf)].join(" ");
const contains = (n, target) => n === target || n.children.some((c) => contains(c, target));
// Simula un clic como lo vive el PopupModal de Spicetify: primero nuestro handler y, al subir el evento,
// el overlay cierra el modal si el elemento pulsado ya no está dentro (Error #6).
function click(root, node) {
  node.listeners.click();
  return contains(root, node); // false = el modal se habría cerrado
}
const parentOf = (n, target) => (n.children.includes(target) ? n : n.children.map((c) => parentOf(c, target)).find(Boolean));
const findButton = (n, text) => (n.tag === "button" && n.textContent === text ? n : n.children.map((c) => findButton(c, text)).find(Boolean));

// Arranca la extensión en un "Spotify" falso. disk = el localStorage que sobrevive entre arranques.
function boot(disk, clock, initialState = null) {
  const L = {}; // listeners registrados por la extensión
  class FakeDate extends Date {
    constructor(...a) { super(...(a.length ? a : [clock.t])); }
    static now() { return clock.t; }
  }
  const win = { addEventListener: (t, cb) => (L["window:" + t] = cb), localStorage: disk };
  const Spicetify = {
    Platform: {},
    showNotification: () => {},
    LocalStorage: { get: (k) => (k in disk ? disk[k] : null), set: (k, v) => (disk[k] = String(v)), remove: (k) => delete disk[k] },
    Player: { data: initialState, isPlaying: () => true, addEventListener: (t, cb) => (L[t] = cb), playUri: (u) => (L.played = u) },
    Topbar: { Button: class { constructor(label, icon, onClick) { L.topbarClick = onClick; } } },
    PopupModal: { display: (o) => (L.modal = o) },
  };
  const document = { createElement: fakeEl };
  const ctx = { Spicetify, window: win, document, console: { log() {}, warn() {}, error() {} }, setTimeout, Date: FakeDate };
  vm.runInNewContext(SRC, ctx);
  const emit = (st) => { L.songchange?.({ data: st }); L.onplaypause?.({ data: st }); }; // llegan gemelos (D-012)
  return { L, emit, LI: win.ListeningIntelligence, disk };
}

const st = (uri, isPaused = false) => ({
  item: { uri, name: uri.slice(-1), artists: [{ uri: "spotify:artist:x", name: "X" }], album: { uri: "spotify:album:1" } },
  duration: 200 * S, isPaused, shuffle: false, smartShuffle: false, context: { uri: "spotify:playlist:p" },
});
const saved = (disk) => JSON.parse(disk["listening-intelligence:v1:store"]);

test("captura, persiste y recupera tras cierre brusco (RF-01…RF-05, CA-03)", () => {
  const disk = {};
  const clock = { t: 1_000_000 };
  let s = boot(disk, clock);
  assert.equal(s.LI.status, "registrando");

  s.emit(st("spotify:track:A")); // empieza A
  clock.t += 40 * S;
  s.emit(st("spotify:track:A", true)); // pausa a los 40 s
  clock.t += 60 * S;
  s.emit(st("spotify:track:A")); // reanuda
  clock.t += 10 * S;
  s.emit(st("spotify:track:B")); // cambio: A = 50 s
  clock.t += 20 * S;
  s.L.onprogress(); // latido a los 20 s de B → checkpoint
  clock.t += 3 * S; // 3 s más sonando… y Spotify muere sin aviso (sin beforeunload)

  let data = saved(disk);
  assert.equal(data.schemaVersion, 1);
  assert.equal(data.records.length, 1);
  assert.equal(data.records[0].uri, "spotify:track:A");
  assert.equal(data.records[0].playedMs, 50 * S);
  assert.equal(data.open.uri, "spotify:track:B");

  // Nuevo arranque con el mismo "disco": B se recupera hasta su último checkpoint (20 s).
  clock.t += 3600 * S;
  s = boot(disk, clock);
  data = saved(disk);
  assert.equal(s.LI.store.records.length, 2);
  assert.equal(s.LI.store.records[1].uri, "spotify:track:B");
  assert.equal(s.LI.store.records[1].playedMs, 20 * S);
  assert.equal(s.LI.store.open, null);
});

test("datos corruptos: copia de seguridad intacta y arranque limpio (RF-12, CA-04)", () => {
  const disk = { "listening-intelligence:v1:store": "{esto no es JSON" };
  const clock = { t: 5_000 };
  const s = boot(disk, clock);
  assert.equal(s.LI.status, "registrando");
  assert.equal(disk["listening-intelligence:backup:5000"], "{esto no es JSON"); // original conservado
  assert.equal(s.LI.store.records.length, 0);
});

test("solo usa claves con su prefijo (RNF-04, CA-06)", () => {
  const disk = { "otra-extension:datos": "intocable" };
  const clock = { t: 0 };
  const s = boot(disk, clock);
  s.emit(st("spotify:track:A"));
  clock.t += 40 * S;
  s.emit(st("spotify:track:B"));
  assert.equal(disk["otra-extension:datos"], "intocable");
  for (const k of Object.keys(disk)) assert.ok(k === "otra-extension:datos" || k.startsWith("listening-intelligence:"));
});

test("panel: abre con un registro corrupto y cambia de rango (RF-06, RF-13, CA-04)", () => {
  const clock = { t: Date.UTC(2026, 10, 14, 12) };
  const t0 = clock.t - 3 * 86400 * S; // hace 3 días: fuera de «Hoy», dentro de «7 días»
  const good = { id: "x", uri: "spotify:track:A", kind: "track", title: "Canción A", artists: [{ uri: "spotify:artist:x", name: "Artista X" }],
    albumUri: null, contextUri: null, shuffle: "off", durationMs: 200 * S, startedAt: t0, playedMs: 120 * S, pauses: 0, endedAt: t0 + 120 * S };
  const disk = { "listening-intelligence:v1:store": JSON.stringify({ schemaVersion: 1, observingSince: t0, open: null, records: [good, { basura: true }] }) };
  const s = boot(disk, clock);

  s.L.topbarClick(); // clic en el icono
  const root = s.L.modal.content;
  assert.equal(s.L.modal.title, "Listening Intelligence");
  let text = textOf(root);
  assert.match(text, /1 registros/); // el corrupto se descartó, el panel abre igual
  assert.match(text, /Sin escuchas válidas en este rango/); // «Hoy» está vacío

  assert.ok(click(root, findButton(root, "7 días")), "el chip pulsado debe seguir dentro del modal (Error #6)");
  text = textOf(root);
  assert.match(text, /Artista X/);
  assert.match(text, /Canción A · Artista X/);
  assert.match(text, /Tu semana sonora/); // B: el mapa sustituye a las barras
  assert.match(text, /\b18 h\b/); // las columnas son HORAS, con su «h»: no se confunden con días del mes
  assert.match(text, /Cada casilla es una hora/);
  assert.doesNotMatch(text, /\b0 min/); // días sin escucha → «—», no «0 min»
  const header = parentOf(root, parentOf(root, findButton(root, "Resumen")));
  assert.match(header.style.cssText, /position:sticky/); // pestañas y chips no se van al hacer scroll
  assert.ok(contains(header, findButton(root, "7 días")));

  // C: pestaña «Cómo escuchas» con poco historial → aviso, sin cerrar el modal; los chips de rango siguen visibles
  assert.ok(click(root, findButton(root, "Cómo escuchas")), "cambiar a «Cómo escuchas» no cierra el modal");
  assert.match(textOf(root), /Necesita al menos 20 escuchas en este rango \(llevas 1\)/);
  assert.notEqual(parentOf(root, findButton(root, "Hoy")).style.display, "none");
  assert.doesNotMatch(text, /Por hora del día/);
  assert.match(text, /1 sesión/);
  assert.match(text, /días seguidos · récord 1/);
  assert.match(text, /\b2\b.*minutos escuchados/); // 120 s = 2 min
});

test("Borrar: pide confirmación, borra SOLO lo nuestro y el panel sigue abierto (RF-11, CA-06)", () => {
  const clock = { t: Date.UTC(2026, 10, 14, 12) };
  const disk = { "otra-extension:datos": "intocable", "listening-intelligence:backup:1": "viejo" };
  const s = boot(disk, clock);
  s.emit(st("spotify:track:A"));
  clock.t += 40 * S;
  s.emit(st("spotify:track:B")); // A guardada
  assert.equal(s.LI.store.records.length, 1);

  s.L.topbarClick();
  const root = s.L.modal.content;
  const del = findButton(root, "Borrar");
  assert.ok(click(root, del));
  assert.equal(s.LI.store.records.length, 1, "el primer clic solo pide confirmación");
  assert.match(del.textContent, /Seguro/);
  assert.ok(click(root, del), "tras borrar, el botón sigue dentro del modal (Error #6)");

  assert.equal(s.LI.store.records.length, 0);
  assert.equal(disk["otra-extension:datos"], "intocable");
  assert.ok(!("listening-intelligence:backup:1" in disk), "las copias propias también se borran");
  assert.match(textOf(root), /0 registros/);
});

test("Limpieza: pestaña sin cerrar el modal, ▶ reproduce y Resumen recupera los chips (A1)", () => {
  const clock = { t: Date.UTC(2026, 10, 14, 12) };
  const skip = (i) => {
    const t = clock.t - (i + 1) * 86400 * S;
    return { id: `s${i}`, uri: "spotify:track:S", kind: "track", title: "Canción S", artists: [{ uri: "spotify:artist:x", name: "Artista X" }],
      albumUri: null, contextUri: "spotify:playlist:p1", shuffle: "off", durationMs: 200 * S, startedAt: t, playedMs: 5 * S, pauses: 0, endedAt: t + 5 * S };
  };
  const disk = { "listening-intelligence:v1:store": JSON.stringify({ schemaVersion: 1, observingSince: 0, open: null, records: Array.from({ length: 10 }, (_, i) => skip(i)) }) };
  const s = boot(disk, clock); // Platform sin PlaylistAPI: los nombres de playlist usan el respaldo

  s.L.topbarClick();
  const root = s.L.modal.content;
  const chipsRow = parentOf(root, findButton(root, "Hoy"));
  assert.ok(click(root, findButton(root, "Limpieza")), "cambiar de pestaña no cierra el modal");
  assert.equal(chipsRow.style.display, "none", "en Limpieza no hay rango");
  const text = textOf(root);
  assert.match(text, /Canción S · Artista X/);
  assert.match(text, /⏭ 10/);
  assert.match(text, /Playlist …ist:p1/); // sin PlaylistAPI: nombre de respaldo, sin romper (punto 4)
  assert.match(text, /100 % saltadas \(10\/10\)/);

  const play = findButton(root, "▶");
  assert.ok(click(root, play), "▶ no cierra el modal");
  assert.equal(s.L.played, "spotify:track:S");

  assert.ok(click(root, findButton(root, "Resumen")));
  assert.notEqual(chipsRow.style.display, "none");
  assert.match(textOf(root), /minutos escuchados/);
});

test("Cómo escuchas con ≥ 20 escuchas: pinta el análisis y la tarjeta del aleatorio no apila «x % / y %» (C)", () => {
  const clock = { t: Date.UTC(2026, 10, 14, 12) };
  const rec = (i) => {
    const t = clock.t - (i + 1) * 600 * S; // cada 10 min hacia atrás, todo hoy
    const played = i % 2 ? 5 : 120; // la mitad saltadas
    return { id: `h${i}`, uri: `spotify:track:H${i}`, kind: "track", title: `Canción ${i}`, artists: [{ uri: null, name: "Artista" }],
      albumUri: null, contextUri: "spotify:playlist:p1", shuffle: i < 10 ? "on" : "off", durationMs: 200 * S,
      startedAt: t, playedMs: played * S, pauses: 0, endedAt: t + played * S };
  };
  const disk = { "listening-intelligence:v1:store": JSON.stringify({ schemaVersion: 1, observingSince: 0, open: null, records: Array.from({ length: 20 }, (_, i) => rec(i)) }) };
  const s = boot(disk, clock);
  s.L.topbarClick();
  const root = s.L.modal.content;
  assert.ok(click(root, findButton(root, "Cómo escuchas")));
  const text = textOf(root);
  assert.match(text, /Calculado con 20 escuchas/);
  assert.match(text, /saltas sin aleatorio · con aleatorio: 50 %/); // la segunda cifra va en la etiqueta
  assert.doesNotMatch(text, /% \/ /); // nunca «x % / y %» en el valor grande (se partía en dos líneas)
  assert.ok(click(root, findButton(root, "7 días")), "cambiar de rango en esta pestaña no cierra el modal");
});
