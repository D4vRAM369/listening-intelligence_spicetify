// Listening Intelligence — extensión de Spicetify para registrar y analizar hábitos de escucha.
// Pasos 5–8: registro, persistencia, estadísticas y panel.
// Capas: lógica pura (arriba, testeable con Node) → captura + almacenamiento (abajo, solo en Spotify).

(function listeningIntelligence() {
  "use strict";

  const TAG = "[LI]"; // prefijo para encontrar nuestros mensajes en la consola
  const SCHEMA_VERSION = 1; // forma de los datos guardados (02_ARQUITECTURA § Modelo de datos)
  const PREFIX = "listening-intelligence:"; // todas nuestras claves empiezan así (RNF-04, D-006)
  const STORE_KEY = PREFIX + "v1:store";
  const CHECKPOINT_MS = 15000; // guardar la pista abierta como mucho cada 15 s (RNF-02)
  const VALID_MIN_MS = 30000; // escucha válida: al menos 30 s sonando… (D-004, provisional)
  const VALID_RATIO = 0.5; // …o al menos el 50 % de la duración, lo que llegue antes
  // Umbrales de la pestaña «Limpieza» (A1, D-019). Ajustables: mejor lista vacía que injusta.
  const SKIP_MIN = 3; // «siempre las saltas»: al menos 3 saltos y ninguna válida
  const MISSED_MIN_VALID = 5; // «las echas de menos»: al menos 5 válidas…
  const MISSED_DAYS = 30; // …y la última hace MÁS de 30 días
  const PLAYLIST_MIN = 10; // una playlist necesita 10 escuchas para opinar sobre ella
  const LIST_MAX = 10;
  // «Cómo escuchas» (C, D-021): hábitos, no gustos (frontera con Musical DNA). Mejor sin datos que con 3.
  const HABITS_MIN = 20; // escuchas mínimas en el rango para sacar conclusiones
  const COMPLETE_RATIO = 0.9; // «entera» = al menos el 90 % de la canción
  const FAST_SKIP_S = 10; // insignia ⏭: mediana de saltos por debajo de 10 s
  const REPEAT_HIGH = 0.7; // 🔁: al menos el 70 % de las válidas son canciones ya escuchadas
  const EXPLORE_HIGH = 0.5; // 🧭: al menos el 50 % son primeras veces
  const ALBUM_HIGH = 0.5; // 💿: al menos la mitad desde álbumes
  const SHUFFLE_GAP = 0.2; // 🎲: con aleatorio saltas 20 puntos más que sin él
  const WHOLE_HIGH = 0.8; // 🎧: atención media de al menos el 80 %
  const SESSION_GAP_MIN = 20; // «Tu semana sonora» (B, D-020): hueco máximo dentro de una misma sesión

  // ═══════════════════════════════════════════════════════════════════════
  // LÓGICA PURA: no toca Spotify, ni el disco, ni Date.now(). Se prueba con Node.
  // ═══════════════════════════════════════════════════════════════════════

  // Tipo de elemento según su URI (Q-02: así episodios y archivos locales no se mezclan con pistas).
  function kindOf(uri) {
    if (uri.startsWith("spotify:track:")) return "track";
    if (uri.startsWith("spotify:episode:")) return "episode";
    if (uri.startsWith("spotify:local:")) return "local";
    return "other";
  }

  // shuffle + smartShuffle → un solo campo con tres valores (D-011).
  function shuffleMode(state) {
    if (state.smartShuffle) return "smart";
    return state.shuffle ? "on" : "off";
  }

  // PlayerState → registro abierto (la pista que suena ahora). null si no hay URI usable.
  function openRecord(state, now) {
    const item = state?.item;
    const uri = item?.uri;
    if (typeof uri !== "string" || !uri.startsWith("spotify:")) return null; // estado incompleto: se ignora
    return {
      id: `${now}-${uri}`, // único y estable: sirve para fusionar importaciones sin duplicar (RF-10)
      uri,
      kind: kindOf(uri),
      title: item.name ?? "",
      artists: (item.artists ?? []).map((a) => ({ uri: a?.uri ?? null, name: a?.name ?? "" })),
      albumUri: item.album?.uri ?? null,
      contextUri: state.context?.uri || null, // D-011
      shuffle: shuffleMode(state), // D-011
      durationMs: Number(state.duration ?? item.duration?.milliseconds) || 0,
      startedAt: now,
      playedMs: 0,
      pauses: 0,
      playingSince: state.isPaused ? null : now, // D-012: «sonando» sale de isPaused, nunca se supone
      lastSeenAt: now, // último checkpoint: si Spotify se cierra de golpe, se cierra aquí
    };
  }

  // Suma al contador el tramo que lleva sonando hasta `now` (D-003: reloj real, no posición).
  function flush(open, now) {
    if (open.playingSince == null) return { ...open, lastSeenAt: now };
    const played = open.playedMs + Math.max(0, now - open.playingSince); // max: un reloj que retrocede no resta
    return { ...open, playedMs: played, playingSince: now, lastSeenAt: now };
  }

  // Registro abierto → registro cerrado (sin los campos internos del tracker).
  function closeRecord(open, endedAt) {
    const { playingSince, lastSeenAt, ...rec } = flush(open, endedAt);
    return { ...rec, endedAt };
  }

  // Corazón del tracker. Recibe la pista abierta y un estado nuevo; devuelve la nueva pista abierta
  // y, si la anterior terminó, el registro cerrado. Idempotente (D-012): aplicar dos veces el mismo
  // estado en el mismo instante no suma nada extra.
  function applyState(open, state, now) {
    const uri = state?.item?.uri ?? null;
    if (open && uri === open.uri) {
      // Misma pista: pausa, reanudación, o evento gemelo. El bucle también cae aquí (D-007).
      let next = flush(open, now);
      const paused = !!state.isPaused;
      if (paused && next.playingSince != null) next = { ...next, playingSince: null, pauses: next.pauses + 1 };
      else if (!paused && next.playingSince == null) next = { ...next, playingSince: now };
      return { open: next, closed: null };
    }
    // Pista distinta (o ninguna): se cierra la anterior y se abre la nueva.
    const closed = open ? closeRecord(open, now) : null;
    // D-013: una pista con 0 ms sonando no es una escucha (p. ej. la restaurada en pausa al arrancar).
    return { open: openRecord(state, now), closed: closed && closed.playedMs > 0 ? closed : null };
  }

  // Tras un cierre brusco: la pista abierta se cierra en su último checkpoint, no "ahora".
  function recoverOpen(open) {
    const rec = closeRecord({ ...open, playingSince: null }, open.lastSeenAt);
    return rec.playedMs > 0 ? rec : null;
  }

  // Válida o saltada. Se CALCULA, no se guarda (D-004): cambiar el umbral recalcula todo el histórico.
  // Si la duración es desconocida (0), solo cuenta la regla de los 30 s.
  function classify(playedMs, durationMs) {
    if (playedMs >= VALID_MIN_MS) return "valid";
    if (durationMs > 0 && playedMs >= durationMs * VALID_RATIO) return "valid";
    return "skipped";
  }

  // ¿Es un registro creíble? Rechaza lo imposible en vez de dejar que rompa las estadísticas (RF-12).
  function isValidRecord(r) {
    return (
      !!r && typeof r === "object" &&
      typeof r.id === "string" &&
      typeof r.uri === "string" && r.uri.startsWith("spotify:") &&
      Number.isFinite(r.startedAt) && Number.isFinite(r.endedAt) && r.endedAt >= r.startedAt &&
      Number.isFinite(r.playedMs) && r.playedMs > 0 &&
      r.playedMs <= r.endedAt - r.startedAt + 1000 && // no puede sonar más tiempo del que pasó (+1 s de margen)
      Number.isFinite(r.durationMs) && r.durationMs >= 0 &&
      typeof r.title === "string" && // se ordena con localeCompare: un título que no es texto rompería el panel
      Array.isArray(r.artists) && r.artists.every((a) => !!a && typeof a.name === "string")
    );
  }

  function isValidOpen(o) {
    return (
      !!o && typeof o === "object" &&
      typeof o.uri === "string" && o.uri.startsWith("spotify:") &&
      Number.isFinite(o.startedAt) && Number.isFinite(o.lastSeenAt) && Number.isFinite(o.playedMs) &&
      Array.isArray(o.artists)
    );
  }

  function emptyStore(now) {
    return { schemaVersion: SCHEMA_VERSION, observingSince: now, open: null, records: [] };
  }

  // Texto guardado → store. NUNCA lanza: informa de lo que pasó para que quien llama decida
  // (hacer copia de seguridad, avisar...). corrupt = no se pudo usar nada; dropped = registros descartados.
  function parseStore(raw, now) {
    if (raw == null) return { store: emptyStore(now), dropped: 0, corrupt: false }; // primera vez
    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      return { store: emptyStore(now), dropped: 0, corrupt: true }; // JSON ilegible
    }
    if (!data || typeof data !== "object" || !Array.isArray(data.records) || data.schemaVersion !== SCHEMA_VERSION) {
      return { store: emptyStore(now), dropped: 0, corrupt: true }; // forma o versión desconocida
    }
    const records = data.records.filter(isValidRecord);
    const open = isValidOpen(data.open) ? data.open : null;
    const dropped = data.records.length - records.length + (data.open && !open ? 1 : 0);
    const observingSince = Number.isFinite(data.observingSince) ? data.observingSince : records[0]?.startedAt ?? now;
    return { store: { schemaVersion: SCHEMA_VERSION, observingSince, open, records }, dropped, corrupt: false };
  }

  // ─── Estadísticas (Paso 7) ───
  const RANGE_DAYS = { today: 1, "7d": 7, "30d": 30 }; // RF-06
  const TOP_N = 5;

  // Inicio del rango en días NATURALES locales: «7 días» = hoy + los 6 anteriores, desde las 00:00.
  // setDate() en vez de restar 24 h: así un cambio de hora (23 o 25 h) no descuadra el día.
  function rangeStart(range, now) {
    const d = new Date(now);
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() - (RANGE_DAYS[range] - 1));
    return d.getTime();
  }

  // Suma una escucha válida a un ranking (Map clave → {…, count, ms}).
  function bump(map, key, base, ms) {
    const e = map.get(key) ?? { ...base, count: 0, ms: 0 };
    e.count += 1;
    e.ms += ms;
    map.set(key, e);
  }

  // Más escuchas primero; empate → más tiempo escuchado; empate → nombre (orden estable y determinista).
  const byPlays = (a, b) => b.count - a.count || b.ms - a.ms || a.name.localeCompare(b.name);
  function top(map) {
    return [...map.values()].sort(byPlays).slice(0, TOP_N);
  }

  // Histórico + rango → cifras del panel. Pura: `now` es parámetro. Datos crudos → derivados (04 § 2).
  // ponytail: recorre todo el histórico en cada llamada (O(n)); con ~11 000 registros como máximo sobra.
  function aggregate(records, range, now) {
    return aggregateBetween(records, rangeStart(range, now), Infinity);
  }

  // Igual que aggregate, pero con un intervalo [from, to) explícito (Recuerdos, D-024).
  function aggregateBetween(records, from, to) {
    const out = { listenedMs: 0, valid: 0, skipped: 0, byHour: Array(24).fill(0), byWeekday: Array(7).fill(0) };
    const artists = new Map();
    const tracks = new Map();
    for (const r of records) {
      if (r.kind !== "track" || r.startedAt < from || r.startedAt >= to) continue; // Q-02: solo pistas de música
      out.listenedMs += r.playedMs; // minutos = todo lo que sonó, también lo saltado
      if (classify(r.playedMs, r.durationMs) !== "valid") { out.skipped += 1; continue; }
      out.valid += 1;
      const d = new Date(r.startedAt); // hora local del equipo (RF-08)
      out.byHour[d.getHours()] += 1;
      out.byWeekday[(d.getDay() + 6) % 7] += 1; // getDay(): 0 = domingo → lo pasamos a 0 = lunes
      bump(tracks, r.uri, { uri: r.uri, name: r.title, artists: r.artists.map((a) => a.name).join(", ") }, r.playedMs);
      for (const a of r.artists) bump(artists, a.uri ?? a.name, { uri: a.uri, name: a.name }, r.playedMs);
    }
    return { ...out, topArtists: top(artists), topTracks: top(tracks) };
  }

  // ─── Exportar / importar / borrar (Paso 9) ───

  // Store → texto del archivo exportado. Mismo formato que el guardado: parseStore sirve para leerlo (RF-09).
  // La pista abierta no se exporta: aún no es una escucha terminada.
  function serialize(store) {
    return JSON.stringify({ ...store, open: null }, null, 2); // null, 2 = con sangría, legible a ojo
  }

  // Fusiona un store importado en el actual. Une por `id` (RF-10): importar dos veces no duplica.
  function mergeStores(current, incoming) {
    const byId = new Map(current.records.map((r) => [r.id, r]));
    let added = 0;
    for (const r of incoming.records) {
      if (byId.has(r.id)) continue; // ya estaba: se queda la versión actual
      byId.set(r.id, r);
      added += 1;
    }
    const records = [...byId.values()].sort((a, b) => a.startedAt - b.startedAt);
    const observingSince = Math.min(current.observingSince, incoming.observingSince);
    return { store: { ...current, observingSince, records }, added };
  }

  // De todas las claves del almacén, solo las nuestras (RNF-04, CA-06). Lo demás no se toca nunca.
  const ownKeys = (keys) => keys.filter((k) => k.startsWith(PREFIX));

  // ─── Almacenamiento a largo plazo (D-023) ───

  // Arranque: une lo que hay en IndexedDB, la clave antigua de localStorage (migración) y el espejo
  // `pending` (lo que un cierre brusco no dejó confirmar). PURA: decide; quien llama escribe.
  // toPut = registros que IndexedDB aún no tiene. Unir por `id` hace que repetirlo no duplique nada.
  function combineSources({ idbRecords, idbMeta, lsRaw, pendingRaw }, now) {
    const idbIds = new Set(idbRecords.map((r) => r.id));
    let store = { schemaVersion: SCHEMA_VERSION, observingSince: idbMeta?.observingSince ?? Infinity, open: null, records: idbRecords };
    let migrated = false;
    let dropped = 0;
    if (lsRaw != null) {
      const ls = parseStore(lsRaw, now);
      if (!ls.corrupt) {
        migrated = true;
        dropped += ls.dropped;
        store = mergeStores(store, ls.store).store;
        store.open = ls.store.open; // una pista abierta de la versión antigua (si la había)
      }
    }
    let pending = null;
    try {
      pending = pendingRaw == null ? null : JSON.parse(pendingRaw);
    } catch {} // espejo ilegible: se ignora, lo importante está en IndexedDB
    if (pending && typeof pending === "object") {
      const unsaved = Array.isArray(pending.unsaved) ? pending.unsaved.filter(isValidRecord) : [];
      store = mergeStores(store, { observingSince: Infinity, records: unsaved }).store;
      if (isValidOpen(pending.open)) store.open = pending.open; // el espejo es lo más reciente
    }
    const first = store.records[0]?.startedAt ?? Infinity;
    store.observingSince = Math.min(store.observingSince, first);
    if (!Number.isFinite(store.observingSince)) store.observingSince = now; // primera vez
    const toPut = store.records.filter((r) => !idbIds.has(r.id));
    return { store, toPut, migrated, dropped };
  }

  // Texto del espejo síncrono en localStorage: la pista abierta + lo que IndexedDB aún no confirmó.
  function pendingPayload(store, unsaved) {
    return JSON.stringify({ open: store.open, unsaved });
  }

  // ─── Tu semana sonora (B) ───

  // ms → texto. «—» si no sonó nada; «<1 min» si sonó algo pero redondearía a 0 (una celda coloreada
  // no puede decir «0 min»); si no, «12 min» o «1 h 5 min».
  function fmtMin(ms) {
    if (!ms) return "—";
    const m = Math.round(ms / 60000);
    if (m === 0) return "<1 min";
    return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`;
  }

  // Medianoche local del día de `ts`, y desplazar N días por CALENDARIO (setDate: un día de 23 o 25 h no descuadra).
  function dayStart(ts) {
    const d = new Date(ts);
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  }
  function shiftDay(ts, n) {
    const d = new Date(ts);
    d.setDate(d.getDate() + n);
    // Se normaliza al inicio real del día: donde la hora cambia A medianoche (Chile, Cuba…) un día empieza
    // a la 01:00 y, sin esto, «el día anterior a las 01:00» no coincidiría con su clave (revisión final B).
    return dayStart(d.getTime());
  }

  // Pistas de música dentro del rango, en orden cronológico.
  const musicIn = (records, range, now) =>
    records.filter((r) => r.kind === "track" && r.startedAt >= rangeStart(range, now)).sort((a, b) => a.startedAt - b.startedAt);

  // Matriz 7 × 24 de ms escuchados (válidas y saltadas: «cuándo suena música»). Fila 0 = lunes; hora de INICIO.
  function heatmap(records, range, now) {
    const m = Array.from({ length: 7 }, () => Array(24).fill(0));
    for (const r of musicIn(records, range, now)) {
      const d = new Date(r.startedAt);
      m[(d.getDay() + 6) % 7][d.getHours()] += r.playedMs;
    }
    return m;
  }

  // Sesión = escuchas seguidas con huecos ≤ SESSION_GAP_MIN entre el final de una y el inicio de la siguiente.
  function sessions(records, range, now) {
    const lens = [];
    let lastEnd = -Infinity;
    for (const r of musicIn(records, range, now)) {
      if (r.startedAt - lastEnd > SESSION_GAP_MIN * 60000) lens.push(0); // hueco grande → sesión nueva
      lens[lens.length - 1] += r.playedMs;
      lastEnd = Math.max(lastEnd, r.endedAt);
    }
    const total = lens.reduce((a, b) => a + b, 0);
    return { count: lens.length, avgMs: lens.length ? Math.round(total / lens.length) : 0, maxMs: Math.max(0, ...lens) };
  }

  // Racha = días seguidos con ≥ 1 escucha válida, sobre TODO el historial. La actual sigue viva si acabó ayer.
  function streak(records, now) {
    const days = new Set(records.filter((r) => r.kind === "track" && classify(r.playedMs, r.durationMs) === "valid").map((r) => dayStart(r.startedAt)));
    let best = 0, run = 0, prev = null;
    for (const d of [...days].sort((a, b) => a - b)) {
      run = prev != null && shiftDay(prev, 1) === d ? run + 1 : 1;
      best = Math.max(best, run);
      prev = d;
    }
    let current = 0;
    let d = dayStart(now);
    if (!days.has(d)) d = shiftDay(d, -1); // aún no has escuchado hoy: se mira desde ayer
    while (days.has(d)) {
      current += 1;
      d = shiftDay(d, -1);
    }
    return { current, best };
  }

  // ─── Cómo escuchas (C) ───

  const pct = (x) => `${Math.round(x * 100)} %`;
  // ms → «9,6 s». TRUNCA a una décima (no redondea): 9 999 ms es «9,9 s», nunca «10 s», que contradiría «menos de 10 s».
  const fmtSec = (ms) => `${(Math.floor(ms / 100) / 10).toLocaleString("es-ES")} s`;
  const median = (xs) => {
    if (!xs.length) return null;
    const a = [...xs].sort((x, y) => x - y), m = a.length >> 1; // >> 1 = dividir entre 2 sin decimales
    return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2; // par → media de los dos centrales
  };
  // Tipo de sitio desde el que se lanzó la música, a partir de su URI.
  function sourceOf(ctx) {
    for (const k of ["playlist", "album", "artist", "track"]) if (ctx?.startsWith(`spotify:${k}:`)) return k;
    return "other"; // nulo, «Tus me gusta» (…:collection), radio…
  }

  // Rango → hábitos de escucha. Usa tiempos, saltos, aleatorio, repetición por PISTA y contexto: nunca artistas.
  function habits(records, range, now) {
    const rs = musicIn(records, range, now);
    if (rs.length < HABITS_MIN) return { n: rs.length, enough: false };
    const isValid = (r) => classify(r.playedMs, r.durationMs) === "valid";

    // Primera escucha válida de cada pista en TODO el historial: lo anterior a ella es «descubrir», lo posterior «repetir».
    const firstValid = new Map();
    for (const r of records) if (r.kind === "track" && isValid(r) && !(firstValid.get(r.uri) <= r.startedAt)) firstValid.set(r.uri, r.startedAt);

    let completed = 0, skipped = 0, ratioSum = 0, ratioN = 0, valid = 0, repeated = 0;
    const skipMs = [];
    const shuffle = { on: [0, 0], off: [0, 0] }; // [saltadas, total]
    const sources = { playlist: 0, album: 0, artist: 0, track: 0, other: 0 };
    for (const r of rs) {
      const v = isValid(r);
      if (r.durationMs > 0) {
        const ratio = Math.min(r.playedMs / r.durationMs, 1); // un bucle (D-007) no cuenta más de 1
        ratioSum += ratio;
        ratioN += 1;
        if (ratio >= COMPLETE_RATIO) completed += 1;
      }
      if (!v) {
        skipped += 1;
        skipMs.push(r.playedMs);
      } else {
        valid += 1;
        if (firstValid.get(r.uri) < r.startedAt) repeated += 1;
      }
      const g = shuffle[r.shuffle === "off" ? "off" : "on"]; // «on» y «smart» cuentan como aleatorio
      g[1] += 1;
      if (!v) g[0] += 1;
      sources[sourceOf(r.contextUri)] += 1;
    }
    const rate = ([sk, tot]) => (tot ? sk / tot : null); // null: no hay con qué comparar
    const h = {
      n: rs.length,
      enough: true,
      attention: ratioN ? ratioSum / ratioN : null,
      completed,
      partial: rs.length - completed - skipped,
      skipped,
      patienceMs: median(skipMs),
      shuffleSkip: { on: rate(shuffle.on), off: rate(shuffle.off) },
      repeatShare: valid ? repeated / valid : null,
      sources,
    };

    // Insignias: cada una lleva su regla y su cifra (explicable, no «personalidad»).
    const b = [];
    if (h.patienceMs != null && h.patienceMs < FAST_SKIP_S * 1000)
      b.push({ id: "fastSkip", label: "⏭ Saltas rápido", rule: `Cuando saltas, lo haces a los ${fmtSec(h.patienceMs)} (mediana; menos de ${FAST_SKIP_S} s)` });
    if (h.repeatShare != null && h.repeatShare >= REPEAT_HIGH)
      b.push({ id: "repeat", label: "🔁 Repites mucho", rule: `${pct(h.repeatShare)} de tus escuchas válidas son canciones que ya habías escuchado (${pct(REPEAT_HIGH)} o más)` });
    if (h.repeatShare != null && 1 - h.repeatShare >= EXPLORE_HIGH)
      b.push({ id: "explore", label: "🧭 Exploras", rule: `${pct(1 - h.repeatShare)} de tus escuchas válidas son primeras veces (${pct(EXPLORE_HIGH)} o más)` });
    if (sources.album / h.n >= ALBUM_HIGH)
      b.push({ id: "albums", label: "💿 Oyente de álbumes", rule: `${pct(sources.album / h.n)} de lo que escuchas sale de álbumes (${pct(ALBUM_HIGH)} o más)` });
    const { on, off } = h.shuffleSkip;
    if (on != null && off != null && on - off >= SHUFFLE_GAP)
      b.push({ id: "shuffleBored", label: "🎲 El aleatorio te aburre", rule: `Con aleatorio saltas el ${pct(on)}; sin él, el ${pct(off)} (${Math.round(SHUFFLE_GAP * 100)} puntos o más de diferencia)` });
    if (h.attention != null && h.attention >= WHOLE_HIGH)
      b.push({ id: "wholeSongs", label: "🎧 Escuchas entero", rule: `Oyes de media el ${pct(h.attention)} de cada canción (${pct(WHOLE_HIGH)} o más)` });
    return { ...h, badges: b.slice(0, 4) };
  }

  // ─── Limpieza (A1) ───
  // Todo el historial → tres listas accionables. Una pasada, agrupando por pista y por playlist.
  function cleanup(records, now) {
    const tracks = new Map(); // uri → { uri, name, artists, skips, valid, lastAt }
    const lists = new Map(); // contextUri → { uri, plays, skipped }
    for (const r of records) {
      if (r.kind !== "track") continue; // D-015
      const valid = classify(r.playedMs, r.durationMs) === "valid";
      const t = tracks.get(r.uri) ?? { uri: r.uri, name: r.title, artists: r.artists.map((a) => a.name).join(", "), skips: 0, valid: 0, lastAt: 0 };
      if (valid) {
        t.valid += 1;
        t.lastAt = Math.max(t.lastAt, r.startedAt); // última vez que se escuchó de verdad
      } else t.skips += 1;
      tracks.set(r.uri, t);
      if (r.contextUri?.startsWith("spotify:playlist:")) {
        const l = lists.get(r.contextUri) ?? { uri: r.contextUri, plays: 0, skipped: 0 };
        l.plays += 1;
        if (!valid) l.skipped += 1;
        lists.set(r.contextUri, l);
      }
    }
    const all = [...tracks.values()];
    const alwaysSkipped = all
      .filter((t) => t.skips >= SKIP_MIN && t.valid === 0)
      .sort((a, b) => b.skips - a.skips || a.name.localeCompare(b.name))
      .map(({ uri, name, artists, skips }) => ({ uri, name, artists, skips }));
    const missed = all
      .filter((t) => t.valid >= MISSED_MIN_VALID && now - t.lastAt > MISSED_DAYS * 86400000) // > estricto
      .sort((a, b) => b.valid - a.valid || a.lastAt - b.lastAt)
      .map(({ uri, name, artists, valid, lastAt }) => ({ uri, name, artists, valid, lastAt }));
    const playlists = [...lists.values()]
      .filter((l) => l.plays >= PLAYLIST_MIN)
      .map((l) => ({ ...l, rate: l.skipped / l.plays }))
      .sort((a, b) => b.rate - a.rate || b.plays - a.plays);
    return { alwaysSkipped: alwaysSkipped.slice(0, LIST_MAX), missed: missed.slice(0, LIST_MAX), playlists: playlists.slice(0, LIST_MAX) };
  }

  // ─── Tendencias ───

  // Periodo anterior = el mismo tramo RANGE_DAYS días atrás, cortado a la MISMA hora del reloj («ayer a esta hora»).
  // setDate conserva la hora local aunque haya un cambio de hora entre medias (restar N × 24 h no).
  // null si ese periodo empieza antes de observingSince: compararías con días en que no se grababa (▲ 2000 % falso).
  function previousWindow(store, range, now) {
    const d = new Date(now);
    d.setDate(d.getDate() - RANGE_DAYS[range]);
    const prevNow = d.getTime();
    if (store.observingSince > rangeStart(range, prevNow)) return null;
    // Solo lo que ya había pasado a esa hora: las métricas (y «repites») ven el historial como era entonces.
    return { records: store.records.filter((r) => r.startedAt < prevNow), now: prevNow };
  }

  // Cifra actual frente a la anterior → «▲ 18 %» (cantidades), «▼ 5 pts» (tasas 0-1), «▲ 1,2 s» (ms).
  // null si no hay con qué comparar: un valor nulo o, en cantidades, un 0 anterior (no se divide entre 0).
  function trend(cur, prev, kind) {
    if (cur == null || prev == null) return null;
    let n, unit;
    if (kind === "count") {
      if (!prev) return null;
      [n, unit] = [Math.round(((cur - prev) / prev) * 100), "%"];
    } else if (kind === "rate") [n, unit] = [Math.round((cur - prev) * 100), "pts"];
    else [n, unit] = [Math.trunc((cur - prev) / 100), "s"]; // décimas de segundo, truncadas como fmtSec
    if (n === 0) return "= igual";
    if (unit === "pts" && Math.abs(n) === 1) unit = "pt"; // «1 pt», no «1 pts»
    const size = kind === "sec" ? fmtSec(Math.abs(n) * 100) : `${Math.abs(n)} ${unit}`;
    return `${n > 0 ? "▲" : "▼"} ${size}`;
  }

  // ─── Recuerdos (D-024) ───
  const QUEUE_MAX = 50; // «Poner todo en la cola»: como mucho 50 pistas
  const NEW_OBS_DAYS = 30; // el primer mes observado, «descubrir» no significa nada: todo es nuevo

  const pad2 = (n) => String(n).padStart(2, "0");
  const ymd = (ms) => { const d = new Date(ms); return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`; };
  const parseYmd = (str, plusDays = 0) => { const [y, m, d] = str.split("-").map(Number); return new Date(y, m - 1, d + plusDays).getTime(); };

  // Mueve una fecha k meses SIN desbordar: 31-mar − 1 mes = 28-feb (setMonth daría 3-mar).
  function shiftMonths(ms, k) {
    const d = new Date(ms);
    const day = d.getDate();
    d.setDate(1);
    d.setMonth(d.getMonth() + k);
    const last = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate(); // día 0 del mes siguiente = último de este
    d.setDate(Math.min(day, last));
    return d.getTime();
  }

  // "YYYY-MM-DD" × 2 → [00:00 del primero, 00:00 del día siguiente al último): los dos días entran enteros.
  function dayRange(fromStr, toStr) {
    const [a, b] = fromStr <= toStr ? [fromStr, toStr] : [toStr, fromStr]; // ISO: el orden de texto es el de fechas
    return { from: parseYmd(a), to: parseYmd(b, 1) };
  }

  // Atajos del selector → { from, to } como "YYYY-MM-DD".
  function shortcut(name, now, observingSince) {
    const d = new Date(now);
    const y = d.getFullYear();
    if (name === "lastSummer") {
      const sy = now >= new Date(y, 8, 23).getTime() ? y : y - 1; // el último verano YA TERMINADO (acaba el 22-sep)
      return { from: `${sy}-06-21`, to: `${sy}-09-22` };
    }
    if (name === "yearAgoMonth") {
      const last = new Date(y - 1, d.getMonth() + 1, 0).getDate();
      return { from: `${y - 1}-${pad2(d.getMonth() + 1)}-01`, to: `${y - 1}-${pad2(d.getMonth() + 1)}-${pad2(last)}` };
    }
    if (name === "sixMonths") return { from: ymd(shiftMonths(now, -6)), to: ymd(now) };
    return { from: ymd(observingSince), to: ymd(now) }; // "all"
  }

  const slot = (h) => (h < 6 ? "madrugada" : h < 12 ? "mañana" : h < 20 ? "tarde" : "noche");

  // Lo que sonaba entre from y to → los bloques de la pestaña. Pura (no lee el reloj).
  // No inventa pasado: lo anterior al día en que empezó la observación no existe (clippedFrom).
  function memories(records, from, to, observingSince) {
    const clippedFrom = Math.max(from, dayStart(observingSince));
    const agg = aggregateBetween(records, clippedFrom, to);
    const inRange = (t) => t >= clippedFrom && t < to;
    const firstValid = new Map(); // uri → primera escucha VÁLIDA de todo el historial
    const plays = new Map(); // uri → {uri, name, artists, count, ms} solo en el rango
    const slots = new Map(); // uri → recuento por franja
    const dayMs = new Map(); // "YYYY-MM-DD" → ms sonados (también lo saltado, como «minutos escuchados»)
    for (const r of records) {
      if (r.kind !== "track") continue;
      const valid = classify(r.playedMs, r.durationMs) === "valid";
      if (valid && !(firstValid.get(r.uri) <= r.startedAt)) firstValid.set(r.uri, r.startedAt);
      if (!inRange(r.startedAt)) continue;
      const key = ymd(r.startedAt);
      dayMs.set(key, (dayMs.get(key) ?? 0) + r.playedMs);
      if (!valid) continue;
      bump(plays, r.uri, { uri: r.uri, name: r.title, artists: r.artists.map((a) => a.name).join(", ") }, r.playedMs);
      const sl = slots.get(r.uri) ?? {};
      const k = slot(new Date(r.startedAt).getHours());
      sl[k] = (sl[k] ?? 0) + 1;
      slots.set(r.uri, sl);
    }
    const ranked = [...plays.values()].sort(byPlays);
    const t = agg.topTracks[0];
    const song = t ? { ...t, slot: Object.entries(slots.get(t.uri)).sort((a, b) => b[1] - a[1])[0][0] } : null;
    const days = [];
    for (const d = new Date(clippedFrom); d.getTime() < to; d.setDate(d.getDate() + 1)) {
      days.push({ start: d.getTime(), ms: dayMs.get(ymd(d.getTime())) ?? 0 }); // setDate: un día natural aunque dure 23 o 25 h
    }
    const lim = new Date(observingSince);
    lim.setDate(lim.getDate() + NEW_OBS_DAYS);
    return {
      clippedFrom,
      song,
      discoveries: ranked.filter((p) => inRange(firstValid.get(p.uri))),
      discoveriesTitle: from < lim.getTime() ? "Nuevas desde que se observa" : "Descubriste en ese periodo",
      agg,
      days,
      queue: ranked.slice(0, QUEUE_MAX).map((p) => p.uri),
    };
  }

  const core = { memories, dayRange, shortcut, slot, shiftMonths, combineSources, pendingPayload, previousWindow, trend, fmtSec, habits, fmtMin, heatmap, sessions, streak, cleanup, serialize, mergeStores, ownKeys, kindOf, shuffleMode, openRecord, flush, closeRecord, applyState, recoverOpen, classify, isValidRecord, parseStore, emptyStore, rangeStart, aggregate, aggregateBetween, SCHEMA_VERSION, STORE_KEY };

  // En Node (tests) solo exportamos la lógica y salimos: no hay Spotify que esperar.
  if (typeof module !== "undefined" && module.exports) module.exports = core;
  if (typeof window === "undefined") return;

  // ═══════════════════════════════════════════════════════════════════════
  // CAPTURA + ALMACENAMIENTO: solo dentro de Spotify.
  // ═══════════════════════════════════════════════════════════════════════

  // Platform: la doc oficial recomienda esperarlo; llega cuando la interfaz ya está montada.
  const ready = () =>
    typeof Spicetify !== "undefined" &&
    typeof Spicetify.Player?.addEventListener === "function" &&
    typeof Spicetify.LocalStorage?.get === "function" &&
    typeof Spicetify.LocalStorage?.set === "function" &&
    typeof Spicetify.showNotification === "function" &&
    !!Spicetify.Platform;

  // ─── IndexedDB (D-023): capa DELGADA. Toda decisión sobre los datos está en combineSources (pura). ───
  // IndexedDB habla con eventos (onsuccess, onerror...); estos envoltorios los convierten en promesas.
  const DB_NAME = "listening-intelligence";
  const META_KEY = "meta";

  // null si no hay IndexedDB o no se puede abrir: entonces se sigue con localStorage (modo básico).
  function openDB() {
    return new Promise((resolve) => {
      if (typeof indexedDB === "undefined") return resolve(null);
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        // Solo la primera vez (o al subir de versión): se crean los almacenes.
        const db = req.result;
        db.createObjectStore("records", { keyPath: "id" }).createIndex("startedAt", "startedAt");
        db.createObjectStore("meta"); // clave explícita: siempre "meta"
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => {
        console.error(TAG, "no se pudo abrir IndexedDB", req.error);
        resolve(null);
      };
    });
  }

  // Todo lo guardado: los registros (ordenados por startedAt gracias al índice) y el objeto meta.
  function idbAll(db) {
    return new Promise((resolve, reject) => {
      const tx = db.transaction(["records", "meta"], "readonly");
      const recReq = tx.objectStore("records").index("startedAt").getAll();
      const metaReq = tx.objectStore("meta").get(META_KEY);
      tx.oncomplete = () => resolve({ records: recReq.result ?? [], meta: metaReq.result ?? null });
      tx.onerror = () => reject(tx.error);
    });
  }

  // Escribe registros (y meta si se pasa) en UNA transacción: o entra todo o nada.
  // Resuelve en oncomplete, que es cuando el navegador confirma que está guardado.
  function idbPut(db, records, meta) {
    return new Promise((resolve, reject) => {
      const tx = db.transaction(["records", "meta"], "readwrite");
      const rs = tx.objectStore("records");
      for (const r of records) rs.put(r); // put = insertar o reemplazar por `id`: repetir no duplica
      if (meta) tx.objectStore("meta").put(meta, META_KEY);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  }

  function idbClear(db) {
    return new Promise((resolve, reject) => {
      const tx = db.transaction(["records", "meta"], "readwrite");
      tx.objectStore("records").clear();
      tx.objectStore("meta").clear();
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  async function main() {
    const LS = Spicetify.LocalStorage;
    const PENDING_KEY = `${PREFIX}pending`;
    let saveFailed = false; // para avisar del fallo de guardado una sola vez, no en cada checkpoint
    let lastCheckpoint = 0;
    window.ListeningIntelligence = { status: "cargando" }; // IndexedDB es asíncrono: hasta cargar, no se registra

    // Copia intacta del texto original antes de descartar nada: nunca se pierde un dato (RF-12).
    function backupRaw(raw, now) {
      try {
        LS.set(`${PREFIX}backup:${now}`, raw);
      } catch (e) {
        console.error(TAG, "no se pudo hacer copia de seguridad", e);
      }
    }

    const db = await openDB();
    const unsaved = []; // escuchas cerradas que IndexedDB aún no ha confirmado (viven también en el espejo)
    let meta = { schemaVersion: SCHEMA_VERSION, observingSince: Date.now() };

    async function load(now) {
      const lsRaw = LS.get(STORE_KEY);
      const pendingRaw = db ? LS.get(PENDING_KEY) : null;
      let idb = { records: [], meta: null };
      if (db) {
        try {
          idb = await idbAll(db);
        } catch (e) {
          console.error(TAG, "no se pudo leer IndexedDB", e);
        }
      }
      const { store, toPut, migrated, dropped } = core.combineSources({ idbRecords: idb.records, idbMeta: idb.meta, lsRaw, pendingRaw }, now);
      if (lsRaw != null && (dropped > 0 || !migrated)) {
        backupRaw(lsRaw, now); // registros inválidos o texto ilegible: copia intacta antes de seguir
        console.warn(TAG, migrated ? `${dropped} registro(s) inválido(s) descartado(s); copia guardada` : "datos antiguos ilegibles: copia guardada");
      }
      if (store.open) {
        // Spotify se cerró con una pista abierta: se recupera hasta su último checkpoint.
        const rec = core.recoverOpen(store.open);
        if (rec) {
          store.records.push(rec);
          toPut.push(rec);
        }
        store.open = null;
      }
      if (db) {
        meta = { ...(idb.meta ?? {}), schemaVersion: SCHEMA_VERSION, observingSince: store.observingSince };
        try {
          await idbPut(db, toPut, meta);
          // Confirmado en IndexedDB: ahora sí se aparta la clave antigua (renombrada, nunca borrada).
          if (lsRaw != null) {
            if (migrated) LS.set(`${PREFIX}migrated:${new Date(now).toISOString()}`, lsRaw);
            LS.remove(STORE_KEY);
            console.log(TAG, `migración a IndexedDB: ${toPut.length} registro(s) nuevos`);
          }
          LS.set(PENDING_KEY, core.pendingPayload(store, []));
        } catch (e) {
          // No se tocó nada de localStorage: el próximo arranque lo reintenta (combineSources es idempotente).
          console.error(TAG, "no se pudo escribir en IndexedDB; se reintentará", e);
          unsaved.push(...toPut);
        }
        navigator.storage?.persist?.().then((ok) => console.log(TAG, "almacenamiento persistente:", ok));
      }
      return store;
    }

    const store = await load(Date.now());

    // Escribe el espejo síncrono (lo que sobrevive a un cierre brusco). Puede fallar si localStorage está lleno.
    function writePending() {
      try {
        LS.set(PENDING_KEY, core.pendingPayload(store, unsaved));
        saveFailed = false;
      } catch (e) {
        console.error(TAG, "no se pudo guardar", e);
        if (!saveFailed) Spicetify.showNotification("Listening Intelligence: no se pudo guardar", true);
        saveFailed = true;
      }
    }

    // `newRecords`: escuchas recién cerradas o importadas que hay que llevar a IndexedDB.
    function save(newRecords = []) {
      if (!db) {
        // Modo básico (sin IndexedDB): todo el histórico en localStorage, como antes de D-023.
        try {
          LS.set(STORE_KEY, JSON.stringify(store));
          saveFailed = false;
        } catch (e) {
          // Lo típico: localStorage lleno (~5 MB). Los datos siguen en memoria; se reintenta en el siguiente evento.
          console.error(TAG, "no se pudo guardar", e);
          if (!saveFailed) Spicetify.showNotification("Listening Intelligence: no se pudo guardar", true);
          saveFailed = true;
        }
        return;
      }
      unsaved.push(...newRecords);
      writePending(); // primero lo síncrono: si Spotify se cierra ahora, el espejo ya lo tiene
      if (!unsaved.length) return;
      const batch = [...unsaved];
      idbPut(db, batch, meta)
        .then(() => {
          for (const r of batch) unsaved.splice(unsaved.indexOf(r), 1); // confirmado: fuera del espejo
          writePending();
        })
        .catch((e) => console.error(TAG, "IndexedDB no confirmó; sigue en el espejo y se reintentará", e));
    }

    // Un estado nuevo del reproductor (songchange u onplaypause, que llegan gemelos: D-012).
    function onState(state) {
      const now = Date.now();
      const { open, closed } = core.applyState(store.open, state, now);
      store.open = open;
      if (closed) {
        store.records.push(closed);
        console.log(TAG, "registrada", closed.title, `${Math.round(closed.playedMs / 1000)} s`);
      }
      lastCheckpoint = now;
      save(closed ? [closed] : []);
    }

    Spicetify.Player.addEventListener("songchange", (e) => onState(e?.data ?? Spicetify.Player.data));
    Spicetify.Player.addEventListener("onplaypause", (e) => onState(e?.data ?? Spicetify.Player.data));

    // onprogress solo como "latido": checkpoint de la pista abierta cada ≥15 s (RF-03).
    Spicetify.Player.addEventListener("onprogress", () => {
      const now = Date.now();
      if (!store.open || now - lastCheckpoint < CHECKPOINT_MS) return;
      store.open = core.flush(store.open, now);
      lastCheckpoint = now;
      save();
    });

    // Al cerrar Spotify de forma normal, último checkpoint (la pista se cierra al volver a arrancar).
    // Solo el espejo síncrono: una escritura asíncrona aquí podría no terminar antes de cerrarse.
    window.addEventListener("beforeunload", () => {
      if (!store.open) return;
      store.open = core.flush(store.open, Date.now());
      if (db) writePending();
      else save();
    });

    if (Spicetify.Player.data) onState(Spicetify.Player.data); // la pista que ya estaba al arrancar

    // Ventanilla pública para la consola: ListeningIntelligence.store.records, .open, etc.
    window.ListeningIntelligence = {
      status: "registrando",
      storage: db ? "indexeddb" : "localStorage",
      loadedAt: new Date().toISOString(),
      get store() {
        return store;
      },
      core,
    };
    console.log(TAG, "registrando", `${store.records.length} registros`, db ? "(IndexedDB)" : "(modo básico)");
    Spicetify.showNotification(db ? "Listening Intelligence registrando" : "Listening Intelligence: sin base de datos, guardando en modo básico", !db); // D-008

    // Borra SOLO lo nuestro: claves PREFIX (incluye pending, backup: y migrated:) e IndexedDB (RF-11, D-023).
    function wipe() {
      for (const k of ownKeys(Object.keys(window.localStorage))) LS.remove(k);
      store.records.length = 0; // se vacía el MISMO objeto: la UI y la consola lo siguen viendo
      store.open = null;
      store.observingSince = Date.now(); // el histórico empieza de nuevo desde ahora
      unsaved.length = 0;
      meta = { schemaVersion: SCHEMA_VERSION, observingSince: store.observingSince }; // sin backupHandle: copia automática apagada
      if (db) idbClear(db).then(() => idbPut(db, [], meta)).catch((e) => console.error(TAG, "no se pudo vaciar IndexedDB", e));
      save();
    }

    // Texto de un archivo → se fusiona con lo que hay. Devuelve un mensaje para el usuario.
    function importText(text) {
      const { store: incoming, dropped, corrupt } = core.parseStore(text, Date.now());
      if (corrupt) return { ok: false, msg: "Archivo no válido: no se ha importado nada" };
      const before = new Set(store.records.map((r) => r.id));
      const { store: merged, added } = core.mergeStores(store, incoming);
      store.records = merged.records;
      store.observingSince = merged.observingSince;
      meta = { ...meta, observingSince: store.observingSince };
      save(merged.records.filter((r) => !before.has(r.id)));
      const extra = dropped ? ` · ${dropped} descartadas por inválidas` : "";
      return { ok: true, msg: `Importadas ${added} escuchas nuevas · ${incoming.records.length - added} ya estaban${extra}` };
    }

    mountUI(store, { wipe, importText });
  }

  // ═══════════════════════════════════════════════════════════════════════
  // UI (Paso 8): icono A + panel del contrato visual D-010, bloque a bloque.
  // ═══════════════════════════════════════════════════════════════════════

  // Icono A: reloj + barras. Glifo sólido, currentColor (toma el color del tema), viewBox 24.
  const ICON_SVG =
    '<svg role="img" height="18" width="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">' +
    '<path fill-rule="evenodd" d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm0 2a8 8 0 1 1 0 16 8 8 0 0 1 0-16z"/>' +
    '<rect x="7.5" y="11" width="2.2" height="5" rx="1.1"/>' +
    '<rect x="10.9" y="7.5" width="2.2" height="8.5" rx="1.1"/>' +
    '<rect x="14.3" y="9.5" width="2.2" height="6.5" rx="1.1"/></svg>';

  const RANGES = [["today", "Hoy"], ["7d", "7 días"], ["30d", "30 días"]]; // RF-06
  const DAYS = ["L", "M", "X", "J", "V", "S", "D"]; // 0 = lunes, como byWeekday
  // Estilos reutilizados. Colores SOLO del tema (var(--spice-*)), nunca fijos (D-010).
  const SUB = "color:var(--spice-subtext);font-size:13px";
  const H = "font-weight:700;font-size:14px";
  const CUT = "overflow:hidden;text-overflow:ellipsis;white-space:nowrap"; // texto largo → «…»
  const BTN = "border:none;border-radius:999px;padding:6px 14px;font-size:13px;font-weight:700;cursor:pointer;";
  const ON = "background:var(--spice-button);color:var(--spice-main)";
  const OFF = "background:var(--spice-card);color:var(--spice-text)";

  // Crea un elemento con texto. textContent (no innerHTML): un título de canción nunca se interpreta como HTML.
  function el(tag, text, style) {
    const node = document.createElement(tag);
    if (text != null) node.textContent = text;
    if (style) node.style.cssText = style;
    return node;
  }

  function button(text, style, onClick) {
    const b = el("button", text, BTN + style);
    if (onClick) b.addEventListener("click", onClick);
    return b;
  }

  // Bloque 2: tarjeta con una cifra grande y su etiqueta.
  // `delta` (opcional) = tendencia «▲ 18 %» en gris: describe, no juzga (sin verde ni rojo).
  function card(label, value, delta) {
    const c = el("div", null, "flex:1 1 120px;background:var(--spice-card);border-radius:8px;padding:12px 16px");
    c.append(el("div", value, "font-size:26px;font-weight:700"), el("div", label, SUB));
    if (delta) c.append(el("div", delta, `${SUB};margin-top:4px`));
    return c;
  }

  // Tendencias: periodo anterior + la leyenda que dice con qué se compara (una sola, no en cada tarjeta).
  const VS = { today: "ayer a esta hora", "7d": "los 7 días anteriores (hasta esta hora)", "30d": "los 30 días anteriores (hasta esta hora)" };
  function trendSetup(store, range, now) {
    const w = previousWindow(store, range, now);
    const legend = w
      ? `Flechas: frente a ${VS[range]}.`
      : `Sin tendencias: aún no hay un periodo anterior completo (observando desde ${new Date(store.observingSince).toLocaleDateString("es-ES")}).`;
    return { w, legend: el("div", legend, SUB) };
  }

  // Bloque 3: lista del top con barra proporcional al primero (el primero = 100 %).
  function topList(title, items, label, playable = false) {
    const box = el("div", null, "flex:1 1 240px;min-width:0;display:flex;flex-direction:column;gap:6px");
    box.append(el("div", title, H));
    if (!items.length) box.append(el("div", "Sin escuchas válidas en este rango", SUB));
    const max = items[0]?.count ?? 1;
    for (const it of items) {
      const line = el("div", null, "display:flex;justify-content:space-between;gap:8px;font-size:13px");
      if (playable) line.append(playButton(it.uri, "padding:0 8px"));
      line.append(el("span", label(it), `${CUT};flex:1;min-width:0`), el("span", String(it.count), "flex:none;color:var(--spice-subtext)"));
      box.append(line, el("div", null, `height:4px;width:${(it.count / max) * 100}%;background:var(--spice-button);border-radius:2px`));
    }
    return box;
  }

  const DAY_NAMES = ["Lunes", "Martes", "Miércoles", "Jueves", "Viernes", "Sábado", "Domingo"];

  // Bloque 4 (B, D-020): mapa de calor día × hora con totales al margen. Sustituye a las dos barras de D-010.
  // rows = qué días (0 = lunes) se dibujan: los 7, o solo hoy con el rango «Hoy».
  function heatGrid(m, rows) {
    const max = Math.max(1, ...rows.flatMap((i) => m[i])); // el 1 evita dividir entre 0 sin datos
    const grid = el("div", null, "display:grid;grid-template-columns:20px repeat(24,1fr) 64px;gap:2px;align-items:center;font-size:11px;color:var(--spice-subtext)");
    grid.append(el("span")); // esquina vacía
    // Horas cada 3, CON «h»: sin ella, «18» se leía como el día 18 del mes (feedback de uso).
    for (let h = 0; h < 24; h++) grid.append(el("span", h % 3 === 0 ? `${h} h` : "", "white-space:nowrap"));
    grid.append(el("span"));
    for (const i of rows) {
      grid.append(el("span", DAYS[i]));
      m[i].forEach((v, h) => {
        // Más minutos = más opaco. 0,2 mínimo para que una celda con poco se distinga de una vacía.
        const cell = el("div", null, `height:16px;border-radius:3px;background:${v ? "var(--spice-button)" : "var(--spice-card)"};opacity:${v ? 0.2 + 0.8 * (v / max) : 1}`);
        cell.title = `${DAY_NAMES[i]} ${h} h · ${fmtMin(v)}`;
        grid.append(cell);
      });
      grid.append(el("span", fmtMin(m[i].reduce((a, b) => a + b, 0)), "text-align:right")); // total del día
    }
    const perHour = Array.from({ length: 24 }, (_, h) => rows.reduce((a, i) => a + m[i][h], 0));
    const hmax = Math.max(1, ...perHour);
    grid.append(el("span"));
    perHour.forEach((v, h) => {
      const col = el("div", null, "height:28px;display:flex;align-items:flex-end"); // total por hora, en barras
      const bar = el("div", null, `width:100%;height:${(v / hmax) * 100}%;min-height:${v ? 2 : 0}px;background:var(--spice-button);border-radius:2px 2px 0 0`);
      bar.title = `${h} h · ${fmtMin(v)}`;
      col.append(bar);
      grid.append(col);
    });
    grid.append(el("span"));
    return grid;
  }

  function section(title, content) {
    const box = el("div", null, "display:flex;flex-direction:column;gap:8px");
    box.append(el("div", title, H), content);
    return box;
  }

  const RED = "var(--spice-notification-error, #e22134)";

  // Exportar: diálogo «Guardar como» del sistema; si no existe o falla, al portapapeles (patrón de Marketplace).
  async function exportStore(store) {
    const text = serialize(store);
    try {
      const name = `listening-intelligence-${new Date().toISOString().slice(0, 10)}.json`;
      const handle = await window.showSaveFilePicker({ suggestedName: name, types: [{ description: "JSON", accept: { "application/json": [".json"] } }] });
      const w = await handle.createWritable();
      await w.write(text);
      await w.close();
      Spicetify.showNotification(`Exportadas ${store.records.length} escuchas`);
    } catch (e) {
      if (e?.name === "AbortError") return; // el usuario canceló el diálogo: no es un error
      console.warn(TAG, "no se pudo guardar el archivo; copio al portapapeles", e);
      Spicetify.Platform.ClipboardAPI.copy(text);
      Spicetify.showNotification("No se pudo guardar el archivo: JSON copiado al portapapeles");
    }
  }

  // Bloque 6: pie. Se crea UNA vez (como los chips): sus botones nunca se sacan del DOM (Error #6).
  // Devuelve el pie y una función para actualizar su texto.
  function buildFooter(store, { wipe, importText }, refresh) {
    const foot = el("div", null, "display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap;border-top:1px solid var(--spice-card);padding-top:12px");
    const info = el("span", null, SUB);
    const actions = el("div", null, "display:flex;gap:8px");

    const file = el("input"); // selector de archivo oculto: lo abre el botón Importar
    file.type = "file";
    file.accept = ".json,application/json";
    file.style.cssText = "display:none";
    file.addEventListener("change", async () => {
      const f = file.files?.[0];
      file.value = ""; // permite volver a elegir el mismo archivo
      if (!f) return;
      const { ok, msg } = importText(await f.text());
      Spicetify.showNotification(msg, !ok); // segundo parámetro true = aviso de error
      refresh();
    });

    // Borrar en dos clics: el primero arma, el segundo borra. Mismo botón: solo cambia su texto.
    let armed = false;
    const del = button("Borrar", `${OFF};color:${RED}`, () => {
      if (!armed) {
        armed = true;
        del.textContent = "¿Seguro? Pulsa otra vez";
        return;
      }
      armed = false;
      del.textContent = "Borrar";
      wipe();
      Spicetify.showNotification("Datos de Listening Intelligence borrados");
      refresh();
    });

    actions.append(button("Exportar", OFF, () => exportStore(store)), button("Importar", OFF, () => file.click()), del, file);
    foot.append(info, actions);
    const update = () => (info.textContent = `Observando desde ${new Date(store.observingSince).toLocaleDateString("es-ES")} · ${store.records.length} registros`);
    return { foot, update };
  }

  // Dibuja (o redibuja) los bloques 2-5 para un rango. El selector (bloque 1) NO se toca aquí:
  // si se borrara el chip pulsado, el PopupModal cerraría la ventana (Error #6).
  function renderBody(body, store, range) {
    const now = Date.now();
    const s = core.aggregate(store.records, range, now);
    const total = s.valid + s.skipped;
    const skipRate = (a) => (a.valid + a.skipped ? a.skipped / (a.valid + a.skipped) : null);
    // Tendencias: las MISMAS funciones, con el reloj atrasado al periodo anterior.
    const { w, legend: trendLegend } = trendSetup(store, range, now);
    const p = w && core.aggregate(w.records, range, w.now);
    const pses = w && sessions(w.records, range, w.now);
    let anyArrow = false; // si al final no se dibujó ninguna, la leyenda «Flechas: …» mentiría
    const tr = (cur, prev, kind) => {
      const t = w ? trend(cur, prev, kind) : null;
      if (t) anyArrow = true;
      return t;
    };

    // 2. Tres tarjetas
    const cards = el("div", null, "display:flex;gap:12px;flex-wrap:wrap");
    cards.append(
      card("minutos escuchados", String(Math.round(s.listenedMs / 60000)), tr(s.listenedMs, p?.listenedMs, "count")),
      card("escuchas válidas", String(s.valid), tr(s.valid, p?.valid, "count")),
      card("saltadas", total ? `${s.skipped} (${Math.round((s.skipped / total) * 100)} %)` : "0", tr(skipRate(s), p && skipRate(p), "rate"))
    );

    // 3. Top 5 artistas y top 5 pistas, en dos columnas (una sola si la ventana es estrecha)
    const tops = el("div", null, "display:flex;gap:24px;flex-wrap:wrap");
    tops.append(
      topList("Top artistas", s.topArtists, (a) => a.name),
      topList("Top pistas", s.topTracks, (t) => (t.artists ? `${t.name} · ${t.artists}` : t.name))
    );

    // 4. Tu semana sonora (B): mapa + sesiones + racha
    const rows = range === "today" ? [(new Date(now).getDay() + 6) % 7] : [0, 1, 2, 3, 4, 5, 6];
    const ses = sessions(store.records, range, now);
    const st = streak(store.records, now); // todo el historial
    const week = el("div", null, "display:flex;flex-direction:column;gap:12px");
    const wcards = el("div", null, "display:flex;gap:12px;flex-wrap:wrap");
    wcards.append(
      card(ses.count === 1 ? "sesión" : "sesiones", String(ses.count), tr(ses.count, pses?.count, "count")),
      // Sin sesiones, avgMs = 0 significa «no hay media», no «media de 0»: sin flecha (revisión final, I1).
      card(`de media · máx. ${fmtMin(ses.maxMs)}`, fmtMin(ses.avgMs), tr(ses.count ? ses.avgMs : null, pses?.count ? pses.avgMs : null, "count")),
      card(`días seguidos · récord ${st.best}`, `🔥 ${st.current}`)
    );
    const legend = el("div", "Cada casilla es una hora del día (columnas 0 h – 23 h) de cada día de la semana (filas L – D). Más intensa = más minutos de música.", SUB);
    week.append(legend, heatGrid(heatmap(store.records, range, now), rows), wcards);

    if (w && !anyArrow) trendLegend.textContent = "Sin tendencias: en el periodo anterior no sonó música.";
    body.replaceChildren(trendLegend, cards, tops, section("Tu semana sonora", week));
  }

  // ─── Pestaña «Limpieza» (A1) ───
  const VIEWS = [["summary", "Resumen"], ["habits", "Cómo escuchas"], ["cleanup", "Limpieza"], ["memories", "Recuerdos"]];
  const SHORTCUTS = [["all", "Todo"], ["yearAgoMonth", "Este mes hace un año"], ["lastSummer", "Verano pasado"], ["sixMonths", "Últimos 6 meses"]];
  // Pestañas = texto subrayado, para no confundirlas con los chips de rango (que son píldoras).
  const TAB_ON = "background:none;border-radius:0;padding:6px 2px;color:var(--spice-text);border-bottom:2px solid var(--spice-button)";
  const TAB_OFF = "background:none;border-radius:0;padding:6px 2px;color:var(--spice-subtext);border-bottom:2px solid transparent";

  // ▶ que reproduce una URI. No redibuja nada: pulsarlo nunca saca el botón del DOM (Error #6).
  function playButton(uri, extra = "padding:4px 10px") {
    const play = button("▶", `${OFF};${extra};flex:none`, () => {
      // playUri devuelve una promesa: si falla, se avisa en consola sin romper el panel.
      Spicetify.Player.playUri(uri)?.catch?.((e) => console.warn(TAG, "no se pudo reproducir", e));
    });
    play.title = "Reproducir";
    return play;
  }

  // Filas de canciones con ▶.
  function trackRows(items, stat, empty) {
    const box = el("div", null, "display:flex;flex-direction:column;gap:6px");
    if (!items.length) box.append(el("div", empty, SUB));
    for (const t of items) {
      const row = el("div", null, "display:flex;align-items:center;gap:10px;font-size:13px");
      row.append(playButton(t.uri), el("span", t.artists ? `${t.name} · ${t.artists}` : t.name, `${CUT};flex:1;min-width:0`), el("span", stat(t), "flex:none;color:var(--spice-subtext)"));
      box.append(row);
    }
    return box;
  }

  // Solo guardamos la URI de la playlist: el nombre se pide a Spotify. null si no se puede.
  async function playlistName(uri) {
    try {
      return (await Spicetify.Platform.PlaylistAPI?.getMetadata?.(uri))?.name ?? null;
    } catch (e) {
      return null; // API ausente o cambiada: se queda el nombre de respaldo
    }
  }

  function playlistRows(items) {
    const box = el("div", null, "display:flex;flex-direction:column;gap:6px");
    if (!items.length) box.append(el("div", `Aparece cuando una playlist suma ${PLAYLIST_MIN} escuchas.`, SUB));
    for (const p of items) {
      const name = el("span", `Playlist …${p.uri.slice(-6)}`, `${CUT};flex:1;min-width:0`); // respaldo
      const row = el("div", null, "display:flex;gap:10px;font-size:13px");
      row.append(name, el("span", `${Math.round(p.rate * 100)} % saltadas (${p.skipped}/${p.plays})`, "flex:none;color:var(--spice-subtext)"));
      box.append(row);
      playlistName(p.uri).then((n) => n && (name.textContent = n)); // se cambia el MISMO span cuando llegue
    }
    return box;
  }

  // ─── Pestaña «Cómo escuchas» (C) ───
  const SOURCE_LABELS = { playlist: "Playlists", album: "Álbumes", artist: "Artistas", track: "Canciones sueltas", other: "Otros (Tus me gusta, radio…)" };
  const SOURCE_SHADES = { playlist: 1, album: 0.75, artist: 0.5, track: 0.3, other: 0.15 }; // un solo color del tema, distintas intensidades

  function renderHabits(body, store, range) {
    const now = Date.now();
    const h = habits(store.records, range, now);
    if (!h.enough) {
      body.replaceChildren(el("div", `Necesita al menos ${HABITS_MIN} escuchas en este rango (llevas ${h.n}). Prueba con «7 días» o «30 días».`, SUB));
      return;
    }
    // Insignias: la regla y la cifra van en el title (al pasar el ratón): explicable, no «personalidad».
    const badges = el("div", null, "display:flex;gap:8px;flex-wrap:wrap");
    for (const b of h.badges) {
      const chip = el("span", b.label, "background:var(--spice-card);border-radius:999px;padding:6px 12px;font-size:13px;font-weight:700;cursor:help");
      chip.title = b.rule;
      badges.append(chip);
    }
    if (!h.badges.length) badges.append(el("span", "Sin insignias en este rango: ningún hábito destaca todavía.", SUB));

    const dash = (x, f) => (x == null ? "—" : f(x)); // null → «—» (no hay con qué calcularlo)
    // Tendencias: solo si el periodo anterior también llega a HABITS_MIN (si no, sus cifras no significan nada).
    let { w, legend: trendLegend } = trendSetup(store, range, now);
    const ph = w && habits(w.records, range, w.now);
    if (w && !ph.enough) trendLegend = el("div", `Sin tendencias: el periodo anterior tiene menos de ${HABITS_MIN} escuchas (${ph.n}).`, SUB);
    const tr = (cur, prev, kind) => (ph?.enough ? trend(cur, prev, kind) : null);
    const cards = el("div", null, "display:flex;gap:12px;flex-wrap:wrap");
    cards.append(
      card(`de cada canción · ${h.completed} enteras, ${h.partial} a medias, ${h.skipped} saltadas`, dash(h.attention, pct), tr(h.attention, ph?.attention, "rate")),
      card("antes de saltar (mediana)", dash(h.patienceMs, fmtSec), tr(h.patienceMs, ph?.patienceMs, "sec")),
      // Una cifra grande y la otra en la etiqueta: «x % / y %» no cabía y se partía en dos líneas.
      h.shuffleSkip.off != null
        ? card(`saltas sin aleatorio · con aleatorio: ${dash(h.shuffleSkip.on, pct)}`, pct(h.shuffleSkip.off))
        : card("saltas con aleatorio · sin aleatorio: —", dash(h.shuffleSkip.on, pct)),
      card(`repites · ${dash(h.repeatShare, (r) => pct(1 - r))} descubres`, dash(h.repeatShare, pct), tr(h.repeatShare, ph?.repeatShare, "rate"))
    );

    // Desde dónde: barra apilada + leyenda
    const keys = Object.keys(SOURCE_LABELS).filter((k) => h.sources[k] > 0);
    const bar = el("div", null, "display:flex;height:12px;border-radius:6px;overflow:hidden;background:var(--spice-card)");
    const legend = el("div", null, "display:flex;gap:6px 16px;flex-wrap:wrap;font-size:13px");
    for (const k of keys) {
      const share = h.sources[k] / h.n;
      const color = `background:var(--spice-button);opacity:${SOURCE_SHADES[k]}`;
      const seg = el("div", null, `width:${share * 100}%;${color}`);
      seg.title = `${SOURCE_LABELS[k]}: ${pct(share)}`;
      bar.append(seg);
      const item = el("span", null, "display:flex;align-items:center;gap:6px");
      item.append(el("span", null, `display:inline-block;width:10px;height:10px;border-radius:2px;${color}`), el("span", `${SOURCE_LABELS[k]} ${pct(share)}`));
      legend.append(item);
    }
    const from = el("div", null, "display:flex;flex-direction:column;gap:8px");
    from.append(bar, legend);

    body.replaceChildren(
      el("div", `Calculado con ${h.n} escuchas de este rango. Pasa el ratón por una insignia para ver su regla.`, SUB),
      trendLegend,
      badges,
      cards,
      section("Desde dónde pones la música", from)
    );
  }

  // ─── Pestaña «Recuerdos» (D-024) ───
  const fmtDate = (ms) => new Date(ms).toLocaleDateString("es-ES");
  // Clic que redibuja el cuerpo: se aplaza a después de que el clic termine de subir. Si se quitara el
  // elemento pulsado DURANTE el clic, el overlay del PopupModal creería que se pulsó fuera y cerraría (Error #6).
  const later = (fn) => setTimeout(fn, 0);

  async function queueAll(uris) {
    try {
      await Spicetify.addToQueue(uris.map((uri) => ({ uri })));
      Spicetify.showNotification(`Añadidas ${uris.length} canciones a la cola`);
    } catch (e) {
      console.warn(TAG, "no se pudo añadir a la cola", e);
      Spicetify.showNotification("No se pudo añadir a la cola", true);
    }
  }

  // sel = { from, to } como "YYYY-MM-DD" (los <input type="date"> de la cabecera). pickDay(ymd) = ver solo ese día.
  function renderMemories(body, store, sel, pickDay) {
    const { from, to } = core.dayRange(sel.from, sel.to);
    const m = core.memories(store.records, from, to, store.observingSince);
    const blocks = [];
    if (m.clippedFrom > from) blocks.push(el("div", `Antes del ${fmtDate(store.observingSince)} no hay datos: la extensión aún no observaba.`, SUB));
    const totals = el("div", `${m.days.length} día${m.days.length === 1 ? "" : "s"} · ${fmtMin(m.agg.listenedMs)} · ${m.agg.valid} escuchas · observado desde ${fmtDate(store.observingSince)}`, SUB);
    if (!m.agg.valid) {
      blocks.push(el("div", "En esas fechas no sonó música (o la extensión no la vio).", SUB), totals);
      body.replaceChildren(...blocks);
      return;
    }
    // La canción de ese periodo: la «foto de portada».
    const s = m.song;
    const hero = el("div", null, "display:flex;align-items:center;gap:14px;background:var(--spice-card);border-radius:8px;padding:16px");
    const txt = el("div", null, "flex:1;min-width:0;display:flex;flex-direction:column;gap:2px");
    txt.append(el("div", "La canción de ese periodo", SUB), el("div", s.name, `font-size:20px;font-weight:700;${CUT}`),
      el("div", `${s.artists} · ${s.count} escucha${s.count === 1 ? "" : "s"} · sonó sobre todo de ${s.slot}`, `${SUB};${CUT}`));
    hero.append(txt, playButton(s.uri, "padding:10px 16px;font-size:16px"));
    blocks.push(hero);
    // Descubrimientos: 3 visibles + «y N más».
    if (m.discoveries.length) {
      const disc = trackRows(m.discoveries.slice(0, 3), (t) => `${t.count}`, "");
      if (m.discoveries.length > 3) disc.append(el("div", `y ${m.discoveries.length - 3} más`, SUB));
      blocks.push(section(`${m.discoveriesTitle} · ${m.discoveries.length}`, disc));
    }
    const tops = el("div", null, "display:flex;gap:24px;flex-wrap:wrap");
    tops.append(topList("Top pistas", m.agg.topTracks, (t) => `${t.name} · ${t.artists}`, true), topList("Top artistas", m.agg.topArtists, (a) => a.name));
    blocks.push(tops);
    // Un día: sus 24 horas. Varios: una barra por día; pulsar una = ver ese día.
    // ponytail: con años de rango las barras se estrechan a <1 px; agrupar por semanas/meses si molesta.
    const bars = el("div", null, "display:flex;align-items:flex-end;gap:2px;height:48px");
    if (m.days.length === 1) {
      const hmax = Math.max(1, ...m.agg.byHour);
      m.agg.byHour.forEach((v, h) => {
        const b = el("div", null, `flex:1;min-width:0;height:${Math.max(v ? 8 : 2, (v / hmax) * 100)}%;background:${v ? "var(--spice-button)" : "var(--spice-card)"};border-radius:2px 2px 0 0`);
        b.title = `${h} h · ${v} escucha${v === 1 ? "" : "s"}`;
        bars.append(b);
      });
      // Etiquetas con el MISMO reparto que las barras (flex:1 + gap 2px): cada «h» cae bajo su barra.
      const axis = el("div", null, "display:flex;gap:2px;font-size:11px;color:var(--spice-subtext)");
      for (let h = 0; h < 24; h++) axis.append(el("span", h % 6 === 0 ? `${h} h` : "", "flex:1;min-width:0;white-space:nowrap;overflow:visible"));
      const hours = el("div", null, "display:flex;flex-direction:column;gap:4px");
      hours.append(bars, axis);
      blocks.push(section(`${fmtDate(m.days[0].start)}, hora a hora`, hours));
    } else {
      const dmax = Math.max(1, ...m.days.map((d) => d.ms));
      for (const d of m.days) {
        const b = el("div", null, `flex:1;min-width:0;cursor:pointer;height:${Math.max(d.ms ? 8 : 2, (d.ms / dmax) * 100)}%;background:${d.ms ? "var(--spice-button)" : "var(--spice-card)"};border-radius:2px 2px 0 0`);
        b.title = `${fmtDate(d.start)} · ${fmtMin(d.ms)}`;
        b.addEventListener("click", () => later(() => pickDay(d.start)));
        bars.append(b);
      }
      blocks.push(section("Cada barra es un día · pulsa una para verlo hora a hora", bars));
    }
    const foot = el("div", null, "display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap");
    foot.append(totals, button("Poner todo en la cola", OFF, () => queueAll(m.queue)));
    blocks.push(foot);
    body.replaceChildren(...blocks);
  }

  function renderCleanup(body, store) {
    const now = Date.now();
    const c = cleanup(store.records, now);
    const ago = (t) => Math.floor((now - t) / 86400000);
    body.replaceChildren(
      section("🧹 Siempre las saltas", trackRows(c.alwaysSkipped, (t) => `⏭ ${t.skips}`, `Aparece cuando saltas la misma canción ${SKIP_MIN} veces sin escucharla nunca entera.`)),
      section("🔁 Las echas de menos", trackRows(c.missed, (t) => `✓ ${t.valid} · hace ${ago(t.lastAt)} d`, `Aparece cuando una canción que escuchaste ${MISSED_MIN_VALID} veces o más lleva más de ${MISSED_DAYS} días sin sonar.`)),
      section("📋 Cuánto saltas en cada playlist", playlistRows(c.playlists))
    );
  }

  function mountUI(store, ops) {
    // RNF-06: si esta versión de Spotify no tiene Topbar o PopupModal, la extensión sigue registrando igual.
    if (typeof Spicetify.Topbar?.Button !== "function" || typeof Spicetify.PopupModal?.display !== "function") {
      console.warn(TAG, "Topbar/PopupModal no disponibles: sin icono, el registro sigue funcionando");
      return;
    }
    let range = "today"; // se recuerdan mientras Spotify siga abierto
    let view = "summary";
    new Spicetify.Topbar.Button("Listening Intelligence", ICON_SVG, () => {
      // El panel se construye en cada clic: siempre muestra los datos del momento.
      const COL = "display:flex;flex-direction:column;gap:20px";
      const root = el("div", null, `${COL};color:var(--spice-text)`);
      const body = el("div", null, COL); // bloques 2-6: lo único que se redibuja
      const tabsRow = el("div", null, "display:flex;gap:20px;border-bottom:1px solid var(--spice-card)"); // pestañas: fijas
      const tabs = VIEWS.map(([key, label]) => button(label, "", () => setView(key)));
      const chipsRow = el("div", null, "display:flex;gap:8px"); // bloque 1: se crea UNA vez y sigue en el DOM
      const chips = RANGES.map(([key, label]) => button(label, "", () => setRange(key)));
      // Recuerdos: fechas + atajos, también creados UNA vez (Error #6). Solo se ven en esa pestaña.
      const memRow = el("div", null, "display:none;flex-direction:column;gap:8px");
      const dateIn = () => {
        const i = el("input", null, "background:var(--spice-card);color:var(--spice-text);border:none;border-radius:4px;padding:6px 8px;font-size:13px;color-scheme:dark");
        i.type = "date";
        i.addEventListener("change", () => i.value && refresh()); // vacío (borrado a mano) = no hacer nada
        return i;
      };
      const fromIn = dateIn();
      const toIn = dateIn();
      const setSel = ({ from, to }) => {
        fromIn.value = from;
        toIn.value = to;
        refresh();
      };
      const pickDay = (start) => {
        const d = new Date(start);
        const v = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
        setSel({ from: v, to: v });
      };
      const shortcuts = SHORTCUTS.map(([key, label]) => button(label, OFF, () => setSel(core.shortcut(key, Date.now(), store.observingSince))));
      const datesLine = el("div", null, "display:flex;gap:8px;align-items:center;flex-wrap:wrap");
      datesLine.append(fromIn, el("span", "→", SUB), toIn);
      const shortLine = el("div", null, "display:flex;gap:8px;flex-wrap:wrap");
      shortLine.append(...shortcuts);
      memRow.append(datesLine, shortLine);
      ({ from: fromIn.value, to: toIn.value } = core.shortcut("all", Date.now(), store.observingSince)); // por defecto: todo
      const refresh = () => {
        if (view === "memories") renderMemories(body, store, { from: fromIn.value, to: toIn.value }, pickDay); // Recuerdos: su propio rango
        else if (view === "cleanup") renderCleanup(body, store); // Limpieza: todo el historial
        else if (view === "habits") renderHabits(body, store, range); // Cómo escuchas: el rango elegido
        else renderBody(body, store, range); // Resumen: el rango elegido
        footer.update(); // solo el texto del pie
      };
      const footer = buildFooter(store, ops, refresh);
      function setRange(r) {
        range = r;
        // Solo cambia el estilo de los chips (mismos elementos): el pulsado nunca sale del DOM.
        chips.forEach((c, i) => (c.style.cssText = BTN + (RANGES[i][0] === r ? ON : OFF)));
        refresh();
      }
      function setView(v) {
        view = v;
        tabs.forEach((t, i) => (t.style.cssText = BTN + (VIEWS[i][0] === v ? TAB_ON : TAB_OFF)));
        chipsRow.style.display = v === "cleanup" || v === "memories" ? "none" : "flex"; // «flex», no "": "" borraría el display del cssText
        memRow.style.display = v === "memories" ? "flex" : "none";
        setRange(range); // repinta chips y cuerpo
      }
      tabsRow.append(...tabs);
      chipsRow.append(...chips);
      // Pestañas + chips en una cabecera FIJA: al bajar por el panel siguen a mano (pulido B).
      // Fondo = el del modal (.GenericModal usa --spice-player) para que lo que pasa por debajo no se transparente.
      const header = el("div", null, "position:sticky;top:0;z-index:1;background:var(--spice-player);display:flex;flex-direction:column;gap:12px;padding-bottom:8px");
      header.append(tabsRow, chipsRow, memRow);
      root.append(header, body, footer.foot);
      setView(view);
      Spicetify.PopupModal.display({ title: "Listening Intelligence", content: root, isLarge: true });
    });
  }

  // Reintenta cada 100 ms; se rinde a los 30 s para no quedarse esperando para siempre.
  (function waitForSpicetify(tries = 0) {
    if (ready())
      return main().catch((e) => {
        window.ListeningIntelligence = { status: "error", error: String(e) };
        console.error(TAG, "fallo al arrancar", e);
      });
    if (tries >= 300) {
      window.ListeningIntelligence = { status: "timeout" }; // distingue "esperó y se rindió" de "ni siquiera arrancó"
      return console.warn(TAG, "Spicetify no disponible tras 30 s; extensión desactivada");
    }
    setTimeout(() => waitForSpicetify(tries + 1), 100);
  })();
})();
