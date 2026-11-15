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
async function boot(disk, clock, initialState = null, opts = {}) {
  const L = {}; // listeners registrados por la extensión
  class FakeDate extends Date {
    constructor(...a) { super(...(a.length ? a : [clock.t])); }
    static now() { return clock.t; }
  }
  const win = { addEventListener: (t, cb) => (L["window:" + t] = cb), localStorage: disk };
  const Spicetify = {
    Platform: {},
    showNotification: (msg, isError) => (L.notes ??= []).push({ msg, isError: !!isError }),
    LocalStorage: { get: (k) => (k in disk ? disk[k] : null), set: (k, v) => { if (opts.lsThrow?.(k)) throw new Error("QuotaExceededError"); disk[k] = String(v); }, remove: (k) => delete disk[k] },
    Player: { data: initialState, isPlaying: () => true, addEventListener: (t, cb) => (L[t] = cb), playUri: (u) => (L.played = u) },
    Topbar: { Button: class { constructor(label, icon, onClick) { L.topbarClick = onClick; } } },
    PopupModal: { display: (o) => (L.modal = o) },
  };
  const document = { createElement: fakeEl };
  const ctx = { Spicetify, window: win, document, console: { log() {}, warn() {}, error() {} }, setTimeout, Date: FakeDate, navigator: {} };
  if (opts.idb) ctx.indexedDB = opts.idb;
  vm.runInNewContext(SRC, ctx);
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0)); // main() es asíncrona (D-023): espera a que termine de cargar
  const emit = (st) => { L.songchange?.({ data: st }); L.onplaypause?.({ data: st }); }; // llegan gemelos (D-012)
  return { L, emit, LI: win.ListeningIntelligence, disk };
}

const st = (uri, isPaused = false) => ({
  item: { uri, name: uri.slice(-1), artists: [{ uri: "spotify:artist:x", name: "X" }], album: { uri: "spotify:album:1" } },
  duration: 200 * S, isPaused, shuffle: false, smartShuffle: false, context: { uri: "spotify:playlist:p" },
});
// IndexedDB falsa mínima (Node no tiene). `state` sobrevive entre arranques, como el disco.
// knobs: failGetAll / abortGetAll (la lectura falla o aborta), failClear (Borrar falla).
function fakeIDB(state, knobs = {}) {
  return {
    open() {
      const req = {};
      setTimeout(() => {
        const db = {
          createObjectStore: () => ({ createIndex() {} }),
          transaction() {
            const tx = {};
            const ops = [];
            let fail = null;
            tx.objectStore = (n) => ({
              put: (v) => ops.push(() => (n === "records" ? state.records.set(v.id, v) : (state.meta = v))),
              clear: () => { if (knobs.failClear) fail = "error"; ops.push(() => (n === "records" ? state.records.clear() : (state.meta = undefined))); },
              get: () => { const r = {}; ops.push(() => (r.result = state.meta)); return r; },
              index: () => ({ getAll: () => {
                const r = {};
                if (knobs.failGetAll) fail = "error";
                if (knobs.abortGetAll) fail = "abort";
                ops.push(() => (r.result = [...state.records.values()].sort((a, b) => a.startedAt - b.startedAt)));
                return r;
              } }),
            });
            setTimeout(() => {
              if (fail === "abort") return tx.onabort?.();
              if (fail) { tx.error = new Error("fake"); return tx.onerror?.(); }
              ops.forEach((f) => f());
              tx.oncomplete?.();
            }, 0);
            return tx;
          },
        };
        req.result = db;
        if (!state.created) { state.created = true; req.onupgradeneeded?.(); }
        req.onsuccess();
      }, 0);
      return req;
    },
  };
}
const idbState = () => ({ records: new Map(), meta: undefined });
const STORE = "listening-intelligence:v1:store";
const legacy = (n) => {
  const records = Array.from({ length: n }, (_, i) => ({ id: `L${i}`, uri: `spotify:track:L${i}`, kind: "track", title: `L${i}`, artists: [{ uri: null, name: "X" }],
    albumUri: null, contextUri: null, shuffle: "off", durationMs: 200 * S, startedAt: 1000 + i * 300 * S, playedMs: 100 * S, pauses: 0, endedAt: 1000 + i * 300 * S + 100 * S }));
  return JSON.stringify({ schemaVersion: 1, observingSince: 1000, open: null, records });
};

const saved = (disk) => JSON.parse(disk["listening-intelligence:v1:store"]);

test("captura, persiste y recupera tras cierre brusco (RF-01…RF-05, CA-03)", async () => {
  const disk = {};
  const clock = { t: 1_000_000 };
  let s = await boot(disk, clock);
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
  s = await boot(disk, clock);
  data = saved(disk);
  assert.equal(s.LI.store.records.length, 2);
  assert.equal(s.LI.store.records[1].uri, "spotify:track:B");
  assert.equal(s.LI.store.records[1].playedMs, 20 * S);
  assert.equal(s.LI.store.open, null);
});

test("datos corruptos: copia de seguridad intacta y arranque limpio (RF-12, CA-04)", async () => {
  const disk = { "listening-intelligence:v1:store": "{esto no es JSON" };
  const clock = { t: 5_000 };
  const s = await boot(disk, clock);
  assert.equal(s.LI.status, "registrando");
  assert.equal(disk["listening-intelligence:backup:5000"], "{esto no es JSON"); // original conservado
  assert.equal(s.LI.store.records.length, 0);
});

test("solo usa claves con su prefijo (RNF-04, CA-06)", async () => {
  const disk = { "otra-extension:datos": "intocable" };
  const clock = { t: 0 };
  const s = await boot(disk, clock);
  s.emit(st("spotify:track:A"));
  clock.t += 40 * S;
  s.emit(st("spotify:track:B"));
  assert.equal(disk["otra-extension:datos"], "intocable");
  for (const k of Object.keys(disk)) assert.ok(k === "otra-extension:datos" || k.startsWith("listening-intelligence:"));
});

test("panel: abre con un registro corrupto y cambia de rango (RF-06, RF-13, CA-04)", async () => {
  const clock = { t: Date.UTC(2026, 10, 14, 12) };
  const t0 = clock.t - 3 * 86400 * S; // hace 3 días: fuera de «Hoy», dentro de «7 días»
  const good = { id: "x", uri: "spotify:track:A", kind: "track", title: "Canción A", artists: [{ uri: "spotify:artist:x", name: "Artista X" }],
    albumUri: null, contextUri: null, shuffle: "off", durationMs: 200 * S, startedAt: t0, playedMs: 120 * S, pauses: 0, endedAt: t0 + 120 * S };
  const disk = { "listening-intelligence:v1:store": JSON.stringify({ schemaVersion: 1, observingSince: t0, open: null, records: [good, { basura: true }] }) };
  const s = await boot(disk, clock);

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

test("Borrar: pide confirmación, borra SOLO lo nuestro y el panel sigue abierto (RF-11, CA-06)", async () => {
  const clock = { t: Date.UTC(2026, 10, 14, 12) };
  const disk = { "otra-extension:datos": "intocable", "listening-intelligence:backup:1": "viejo" };
  const s = await boot(disk, clock);
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

test("Limpieza: pestaña sin cerrar el modal, ▶ reproduce y Resumen recupera los chips (A1)", async () => {
  const clock = { t: Date.UTC(2026, 10, 14, 12) };
  const skip = (i) => {
    const t = clock.t - (i + 1) * 86400 * S;
    return { id: `s${i}`, uri: "spotify:track:S", kind: "track", title: "Canción S", artists: [{ uri: "spotify:artist:x", name: "Artista X" }],
      albumUri: null, contextUri: "spotify:playlist:p1", shuffle: "off", durationMs: 200 * S, startedAt: t, playedMs: 5 * S, pauses: 0, endedAt: t + 5 * S };
  };
  const disk = { "listening-intelligence:v1:store": JSON.stringify({ schemaVersion: 1, observingSince: 0, open: null, records: Array.from({ length: 10 }, (_, i) => skip(i)) }) };
  const s = await boot(disk, clock); // Platform sin PlaylistAPI: los nombres de playlist usan el respaldo

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

test("Cómo escuchas con ≥ 20 escuchas: pinta el análisis y la tarjeta del aleatorio no apila «x % / y %» (C)", async () => {
  const clock = { t: Date.UTC(2026, 10, 14, 12) };
  const rec = (i) => {
    const t = clock.t - (i + 1) * 600 * S; // cada 10 min hacia atrás, todo hoy
    const played = i % 2 ? 5 : 120; // la mitad saltadas
    return { id: `h${i}`, uri: `spotify:track:H${i}`, kind: "track", title: `Canción ${i}`, artists: [{ uri: null, name: "Artista" }],
      albumUri: null, contextUri: "spotify:playlist:p1", shuffle: i < 10 ? "on" : "off", durationMs: 200 * S,
      startedAt: t, playedMs: played * S, pauses: 0, endedAt: t + played * S };
  };
  const disk = { "listening-intelligence:v1:store": JSON.stringify({ schemaVersion: 1, observingSince: 0, open: null, records: Array.from({ length: 20 }, (_, i) => rec(i)) }) };
  const s = await boot(disk, clock);
  s.L.topbarClick();
  const root = s.L.modal.content;
  assert.ok(click(root, findButton(root, "Cómo escuchas")));
  const text = textOf(root);
  assert.match(text, /Calculado con 20 escuchas/);
  assert.match(text, /saltas sin aleatorio · con aleatorio: 50 %/); // la segunda cifra va en la etiqueta
  assert.doesNotMatch(text, /% \/ /); // nunca «x % / y %» en el valor grande (se partía en dos líneas)
  assert.ok(click(root, findButton(root, "7 días")), "cambiar de rango en esta pestaña no cierra el modal");
});

test("Tendencias: flechas frente a ayer a esta hora en Resumen y Cómo escuchas", async () => {
  const clock = { t: Date.UTC(2026, 10, 14, 12) };
  // 20 ayer (todas válidas) y 20 hoy (la mitad saltadas), cada 10 min hacia atrás desde la misma hora
  const rec = (i, dayOffset, played) => {
    const t = clock.t - dayOffset * 86_400_000 - (i + 1) * 600 * S;
    return { id: `t${dayOffset}-${i}`, uri: `spotify:track:T${i}`, kind: "track", title: `Canción ${i}`, artists: [{ uri: null, name: "Artista" }],
      albumUri: null, contextUri: "spotify:playlist:p1", shuffle: "off", durationMs: 200 * S,
      startedAt: t, playedMs: played * S, pauses: 0, endedAt: t + played * S };
  };
  const records = [...Array.from({ length: 20 }, (_, i) => rec(i, 1, 120)), ...Array.from({ length: 20 }, (_, i) => rec(i, 0, i % 2 ? 5 : 120))];
  const disk = { "listening-intelligence:v1:store": JSON.stringify({ schemaVersion: 1, observingSince: 0, open: null, records }) };
  const s = await boot(disk, clock);
  s.L.topbarClick();
  const root = s.L.modal.content;
  let text = textOf(root);
  assert.match(text, /frente a ayer a esta hora/);
  assert.match(text, /▼ 50 %/); // válidas: 20 → 10
  assert.ok(click(root, findButton(root, "Cómo escuchas")));
  text = textOf(root);
  assert.match(text, /frente a ayer a esta hora/);
  assert.match(text, /▼ \d+ pts/); // atención baja (la mitad saltadas)
});

test("Tendencias: sin periodo anterior completo → leyenda «Sin tendencias» y ninguna flecha", async () => {
  const clock = { t: Date.UTC(2026, 10, 14, 12) };
  const r = { id: "x", uri: "spotify:track:X", kind: "track", title: "X", artists: [{ uri: null, name: "A" }], albumUri: null, contextUri: null,
    shuffle: "off", durationMs: 200 * S, startedAt: clock.t - 600 * S, playedMs: 120 * S, pauses: 0, endedAt: clock.t - 480 * S };
  const disk = { "listening-intelligence:v1:store": JSON.stringify({ schemaVersion: 1, observingSince: clock.t - 3600 * S, open: null, records: [r] }) };
  const s = await boot(disk, clock);
  s.L.topbarClick();
  const text = textOf(s.L.modal.content);
  assert.match(text, /Sin tendencias: aún no hay un periodo anterior completo/);
  assert.doesNotMatch(text, /[▲▼]/);
});

test("Tendencias: sin sesiones hoy, la media por sesión no lleva flecha (revisión final, I1)", async () => {
  const clock = { t: new Date(2026, 10, 14, 8).getTime() }; // hoy 08:00, aún sin música
  const t = clock.t - 86_400_000 - 3600 * S; // ayer 07:00
  const r = { id: "y", uri: "spotify:track:Y", kind: "track", title: "Y", artists: [{ uri: null, name: "A" }], albumUri: null, contextUri: null,
    shuffle: "off", durationMs: 200 * S, startedAt: t, playedMs: 120 * S, pauses: 0, endedAt: t + 120 * S };
  const disk = { "listening-intelligence:v1:store": JSON.stringify({ schemaVersion: 1, observingSince: 0, open: null, records: [r] }) };
  const s = await boot(disk, clock);
  s.L.topbarClick();
  const findCard = (n) => (n.children.some((c) => c.textContent.startsWith("de media")) ? n : n.children.map(findCard).find(Boolean));
  const avg = findCard(s.L.modal.content);
  assert.match(textOf(avg), /—/); // «—»: no hay media que calcular…
  assert.doesNotMatch(textOf(avg), /[▲▼]/); // …así que tampoco hay tendencia (antes: «— ▼ 100 %»)
});

test("Tendencias: periodo anterior sin música → la leyenda lo dice, en vez de «Flechas: …» sin flechas", async () => {
  const clock = { t: Date.UTC(2026, 10, 14, 12) };
  const r = { id: "x", uri: "spotify:track:X", kind: "track", title: "X", artists: [{ uri: null, name: "A" }], albumUri: null, contextUri: null,
    shuffle: "off", durationMs: 200 * S, startedAt: clock.t - 600 * S, playedMs: 120 * S, pauses: 0, endedAt: clock.t - 480 * S };
  const disk = { "listening-intelligence:v1:store": JSON.stringify({ schemaVersion: 1, observingSince: 0, open: null, records: [r] }) };
  const s = await boot(disk, clock);
  s.L.topbarClick();
  const text = textOf(s.L.modal.content);
  assert.match(text, /Sin tendencias: en el periodo anterior no sonó música/);
  assert.doesNotMatch(text, /Flechas: frente a/);
});

test("Recuerdos: pestaña con la canción del periodo; pulsar un día no cierra el modal y lo enseña hora a hora (D-024)", async () => {
  const clock = { t: new Date(2026, 10, 14, 12).getTime() };
  const rec = (i, uri, title) => {
    const t = new Date(2026, 10, 10 + i, 21).getTime(); // 21 h: «noche»
    return { id: `m${i}${uri}`, uri, kind: "track", title, artists: [{ uri: "spotify:artist:x", name: "Artista X" }],
      albumUri: null, contextUri: null, shuffle: "off", durationMs: 200 * S, startedAt: t, playedMs: 120 * S, pauses: 0, endedAt: t + 120 * S };
  };
  const records = [rec(0, "spotify:track:M", "Canción M"), rec(1, "spotify:track:M", "Canción M"), rec(2, "spotify:track:N", "Canción N")];
  const disk = { "listening-intelligence:v1:store": JSON.stringify({ schemaVersion: 1, observingSince: new Date(2026, 10, 9).getTime(), open: null, records }) };
  const s = await boot(disk, clock);

  s.L.topbarClick();
  const root = s.L.modal.content;
  const chipsRow = parentOf(root, findButton(root, "Hoy"));
  assert.ok(click(root, findButton(root, "Recuerdos")), "cambiar de pestaña no cierra el modal");
  assert.equal(chipsRow.style.display, "none", "Recuerdos tiene su propio rango");
  let text = textOf(root);
  assert.match(text, /La canción de ese periodo/);
  assert.match(text, /Canción M/);
  assert.match(text, /sonó sobre todo de noche/);
  assert.match(text, /Nuevas desde que se observa · 2/);

  const findDay = (n) => (n.title?.startsWith("11/11/2026") ? n : n.children.map(findDay).find(Boolean));
  const bar = findDay(root);
  assert.ok(bar, "hay una barra para el 11-nov");
  assert.ok(click(root, bar), "pulsar una barra no cierra el modal (Error #6)");
  await new Promise((r) => setTimeout(r, 0)); // el redibujo va aplazado
  text = textOf(root);
  assert.match(text, /11\/11\/2026, hora a hora/);

  assert.ok(click(root, findButton(root, "Todo")), "un atajo no cierra el modal");
  assert.match(textOf(root), /Cada barra es un día/);

  // Fechas en DD/MM/AAAA, escritas a mano (a petición del usuario).
  const inputs = (n) => [...(n.placeholder === "dd/mm/aaaa" ? [n] : []), ...n.children.flatMap(inputs)];
  const [fromBox, toBox] = inputs(root);
  assert.equal(fromBox.value, "09/11/2026");
  fromBox.value = "12/11/2026";
  fromBox.listeners.change();
  toBox.value = "12/11/2026";
  toBox.listeners.change();
  assert.match(textOf(root), /12\/11\/2026, hora a hora/);
  fromBox.value = "31/02/2026"; // no existe: se marca en rojo y no se recalcula
  fromBox.listeners.change();
  assert.match(fromBox.style.borderColor, /notification-error/);
  assert.match(textOf(root), /12\/11\/2026, hora a hora/);
});

test("Tal día como hoy: la tarjeta sale en Resumen solo si hay música de esa fecha (D-024)", async () => {
  const clock = { t: new Date(2026, 10, 14, 12).getTime() };
  const t = new Date(2026, 9, 14, 20).getTime(); // hace un mes
  const r = { id: "otd", uri: "spotify:track:O", kind: "track", title: "Canción O", artists: [{ uri: null, name: "Artista O" }],
    albumUri: null, contextUri: null, shuffle: "off", durationMs: 200 * S, startedAt: t, playedMs: 120 * S, pauses: 0, endedAt: t + 120 * S };
  let s = await boot({ "listening-intelligence:v1:store": JSON.stringify({ schemaVersion: 1, observingSince: t, open: null, records: [r] }) }, clock);
  s.L.topbarClick();
  assert.match(textOf(s.L.modal.content), /Tal día como hoy, hace un mes.*Escuchabas Canción O · Artista O \(1 vez\)/s);

  s = await boot({ "listening-intelligence:v1:store": JSON.stringify({ schemaVersion: 1, observingSince: t, open: null, records: [{ ...r, startedAt: t - 86400 * S, endedAt: t - 86400 * S + 120 * S }] }) }, clock);
  s.L.topbarClick();
  assert.doesNotMatch(textOf(s.L.modal.content), /Tal día como hoy/);
});

// ─── Revisión final (D-023): rutas de pérdida de datos con IndexedDB ───

test("migración con localStorage casi lleno: se completa y no se repite (revisión, I2)", async () => {
  const disk = { [STORE]: legacy(3) };
  const st = idbState();
  const s = await boot(disk, { t: 9e12 }, null, { idb: fakeIDB(st), lsThrow: (k) => k.includes(":migrated:") });
  assert.equal(st.records.size, 3, "los 3 registros están en IndexedDB");
  assert.ok(!(STORE in disk), "la clave antigua se retira aunque no quepa la copia migrated:");
  assert.equal(s.LI.status, "registrando");
  assert.ok(!(s.L.notes ?? []).some((n) => n.isError), `sin aviso falso de error: ${JSON.stringify(s.L.notes)}`);
});

test("clave antigua ilegible y sin sitio para su copia: NO se borra el único original (revisión, I2 / RF-12)", async () => {
  const disk = { [STORE]: "{roto" };
  await boot(disk, { t: 9e12 }, null, { idb: fakeIDB(idbState()), lsThrow: (k) => k.includes(":backup:") });
  assert.equal(disk[STORE], "{roto");
});

test("si falla la lectura de IndexedDB no se pisa lo guardado y se avisa (revisión, I3)", async () => {
  const st = idbState();
  st.created = true;
  st.records.set("A", JSON.parse(legacy(1)).records[0]);
  st.meta = { schemaVersion: 1, observingSince: 1000 };
  const s = await boot({}, { t: 9e12 }, null, { idb: fakeIDB(st, { failGetAll: true }) });
  assert.equal(st.meta.observingSince, 1000, "meta intacto");
  assert.equal(st.records.size, 1, "registros intactos");
  assert.ok((s.L.notes ?? []).some((n) => n.isError), "aviso visible");
  assert.equal(s.LI.status, "registrando", "sigue registrando (en modo básico, se unirá al reiniciar)");
});

test("si la lectura de IndexedDB ABORTA, el arranque no se queda colgado (revisión, minor → importante)", async () => {
  const st = idbState();
  st.created = true;
  const s = await boot({}, { t: 9e12 }, null, { idb: fakeIDB(st, { abortGetAll: true }) });
  assert.equal(s.LI.status, "registrando");
});

test("Borrar avisa del error si IndexedDB no se vació (revisión, I4)", async () => {
  const st = idbState();
  const s = await boot({ [STORE]: legacy(2) }, { t: 9e12 }, null, { idb: fakeIDB(st, { failClear: true }) });
  s.L.topbarClick();
  const root = s.L.modal.content;
  click(root, findButton(root, "Borrar"));
  click(root, findButton(root, "¿Seguro? Pulsa otra vez"));
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
  const last = s.L.notes.at(-1);
  assert.ok(last.isError, `el último aviso es de error: «${last.msg}»`);
});

test("el panel recuerda el último rango aunque se reinicie Spotify; un valor raro vuelve a «Hoy»", async () => {
  const clock = { t: Date.UTC(2026, 10, 14, 12) };
  const t0 = clock.t - 3 * 86400 * S; // fuera de «Hoy», dentro de «7 días»
  const rec = { id: "x", uri: "spotify:track:A", kind: "track", title: "Canción A", artists: [{ uri: "spotify:artist:x", name: "Artista X" }],
    albumUri: null, contextUri: null, shuffle: "off", durationMs: 200 * S, startedAt: t0, playedMs: 120 * S, pauses: 0, endedAt: t0 + 120 * S };
  const disk = { "listening-intelligence:v1:store": JSON.stringify({ schemaVersion: 1, observingSince: t0, open: null, records: [rec] }) };
  let s = await boot(disk, clock);
  s.L.topbarClick();
  click(s.L.modal.content, findButton(s.L.modal.content, "7 días"));
  assert.equal(disk["listening-intelligence:range"], "7d");

  s = await boot(disk, clock); // «reinicio de Spotify»: mismo disco
  s.L.topbarClick();
  assert.match(textOf(s.L.modal.content), /Canción A · Artista X/); // abre ya en «7 días»

  disk["listening-intelligence:range"] = "toString"; // valor que no es un rango (y que «in» aceptaría por herencia)
  s = await boot(disk, clock);
  s.L.topbarClick();
  assert.match(textOf(s.L.modal.content), /Sin escuchas válidas en este rango/); // «Hoy»
});
