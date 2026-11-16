<p align="center"><img src="assets/banner.png" alt="Listening Intelligence: qué, cuándo y cómo escuchas en Spotify"></p>

# Listening Intelligence

Extensión de [Spicetify](https://spicetify.app) que registra **qué, cuándo y cómo escuchas** en Spotify y te lo enseña en un panel. Todo se queda en tu equipo.

> **Estado: v0.1 beta.** Funciona y tiene 92 tests, pero el historial se ha probado con pocos días de uso real. La interfaz está en español.

*English summary: a Spicetify extension that logs your Spotify listening locally (IndexedDB, nothing leaves your machine) and shows stats, listening habits, trends, a weekly heatmap, a cleanup list of songs you always skip, and "Memories": what you were listening to between any two dates. UI in Spanish.*

## Qué hace

Un icono en la barra superior de Spotify abre un panel con cuatro pestañas:

| Pestaña | Qué ves |
|---|---|
| **Resumen** | Minutos escuchados, escuchas válidas y saltadas, top artistas y pistas, mapa de calor día × hora, sesiones y racha de días. Cada cifra lleva su cambio frente al periodo anterior «a esta hora» (▲ 18 %). Rangos: hoy, 7 días, 30 días. |
| **Cómo escuchas** | Hábitos con reglas visibles: atención, paciencia antes de saltar, aleatorio, repetir o descubrir, desde dónde escuchas. |
| **Limpieza** | Canciones que siempre saltas, las que echas de menos y las playlists donde más saltas, con ▶ para comprobarlo. Solo lectura: no toca tus playlists. |
| **Recuerdos** | Elige dos fechas (DD/MM/AAAA) y mira qué sonaba: la canción de ese periodo, lo que descubriste, los tops, una barra por día (pulsa una para verla hora a hora) y «Poner todo en la cola». |

En Resumen aparece además **«Tal día como hoy»** cuando hay música del mismo día hace un año (o, si no, hace un mes).

**Qué cuenta como escucha válida:** al menos 30 s sonando o el 50 % de la canción, lo que llegue antes. Los minutos cuentan todo lo que sonó, también lo saltado.

## Privacidad

- **Nada sale de tu equipo.** No hay servidor, ni cuentas, ni llamadas a la API web de Spotify.
- El historial se guarda en IndexedDB, dentro del propio cliente de Spotify.
- Solo se registra lo que la extensión ve desde que la instalas: no puede recuperar escuchas anteriores.
- **Exportar / Importar / Borrar** están en el pie del panel. Borrar pide confirmación y solo toca los datos de esta extensión.

### Haz copias de vez en cuando

Spotify guarda los datos de las extensiones en una carpeta de **caché**. Si la vacías, o reinstalas Spotify, el historial se pierde. Usa **Exportar** y guarda el archivo `.json` en otro sitio; **Importar** lo vuelve a unir sin duplicar nada. El pie del panel recuerda cuándo fue la última copia. (La extensión no puede hacer copias automáticas: Spotify no conserva el permiso de escritura entre reinicios.)

## Instalación

**Requisitos:** Spotify de escritorio con [Spicetify](https://spicetify.app/docs/getting-started) instalado.

1. Descarga `listening-intelligence.js`.
2. Cópialo a la carpeta `Extensions` de Spicetify. Para saber dónde está:
   ```bash
   spicetify config-dir
   ```
3. Actívalo y aplica:
   ```bash
   spicetify config extensions listening-intelligence.js
   spicetify apply
   ```
4. Spotify se reinicia y muestra el aviso «Listening Intelligence registrando». El icono (un reloj con barras) aparece en la barra superior.

Para desinstalar: `spicetify config extensions listening-intelligence.js-` y `spicetify apply`.

## Formato de los datos

El historial está pensado para que otras extensiones (como una futura *Musical DNA*) lo lean. Las dos corren en la misma página de Spotify, así que pueden abrir la misma base de datos.

- **IndexedDB** `listening-intelligence`, versión 1.
  - Almacén `records` (clave `id`, índice `startedAt`): una entrada por escucha.
  - Almacén `meta` (clave `"meta"`): `{ schemaVersion: 1, observingSince }`.
- El archivo de **Exportar** tiene la misma forma: `{ schemaVersion: 1, observingSince, open: null, records: [...] }`.

Un registro:

```json
{
  "id": "1794694392388-spotify:track:3jzVD4wI9bwSQBvKu1ifxD",
  "uri": "spotify:track:3jzVD4wI9bwSQBvKu1ifxD",
  "kind": "track",
  "title": "Spanish Guitar",
  "artists": [{ "uri": "spotify:artist:23wr9RJZg0PmYvVFyNkQ4j", "name": "Gary Moore" }],
  "albumUri": "spotify:album:4MhYmImJG6tKPgzRHxFfUm",
  "contextUri": "spotify:playlist:37i9dQZF1F5p3rmiWPIYgZ",
  "shuffle": "on",
  "durationMs": 237293,
  "startedAt": 1794694392388,
  "playedMs": 237785,
  "pauses": 0,
  "endedAt": 1794694630173
}
```

- Las fechas son milisegundos desde 1970 (`Date.now()`).
- `kind`: `track`, `episode`, `local` u `other`. Las estadísticas solo usan `track`.
- `shuffle`: `off`, `on` o `smart`.
- Si la forma cambia, `schemaVersion` subirá.

## Desarrollo

Todo el código está en un solo archivo, por capas: lógica pura arriba (exportada como `core`, sin Spotify), captura y almacenamiento en medio, interfaz abajo.

```bash
npm test                              # 92 tests: lógica pura + extremo a extremo con un Spotify simulado
```

Node 20 o superior. Sin dependencias.

Para depurar contra Spotify real desde la terminal:

```bash
flatpak run com.spotify.Client --remote-debugging-port=9222 &   # o el equivalente en tu sistema
node --experimental-websocket tools/cdp.js 'ListeningIntelligence.store.records.length'
```

⚠️ Con el puerto de depuración abierto, cualquier programa de tu equipo puede controlar Spotify. Ciérralo al terminar.

Los comentarios del código citan identificadores como `D-024` o `Error #6`: vienen de un diario de diseño interno que no forma parte del repositorio.

## Limitaciones conocidas

- Solo se ha probado en Linux (Spotify flatpak, cliente 1.2.95).
- No se ha probado con Spotify Connect (reproducir en otro dispositivo), ni a fondo con pódcasts o archivos locales.
- Con rangos de varios años, las barras por día de Recuerdos se vuelven muy finas.

## Licencia

[MIT](LICENSE).
