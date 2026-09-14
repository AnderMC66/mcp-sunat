# sunat-datos-abiertos-mcp

Servidor MCP (Model Context Protocol) + CLI para consultar los datasets de **SUNAT** publicados en la
[Plataforma Nacional de Datos Abiertos del Perú](https://www.datosabiertos.gob.pe): padrón RUC con
clasificación CIIU, padrón de emisores de comprobantes electrónicos, agentes de retención/percepción
de IGV, etc.

La idea central: **los archivos son enormes (el padrón RUC son ~230 MB comprimidos y ~3 GB de CSV
con 12.5 millones de filas) y descargarlos para responder una pregunta no tiene sentido.** Este
servidor los lee en streaming y filtra, agrupa y perfila sobre la marcha, sin escribir nada en disco.

## Requisitos

- Node.js 18+ (probado en Node 24)

## Instalación

```bash
npm install
npm run build
```

## Tools disponibles (MCP)

### Catálogo

| Tool | Descripción |
|---|---|
| `sunat_listar_datasets` | Lista los datasets de SUNAT (slug, título, nº de recursos). Cacheado. |
| `sunat_buscar_recursos` | Busca archivos por palabras clave en todo el catálogo, sin tildes ni mayúsculas. La vía más rápida al `id` de un recurso. |
| `sunat_obtener_dataset` | Detalle y lista completa de recursos de un dataset. Cacheado. |
| `sunat_recurso_mas_reciente` | El recurso del periodo más reciente de un dataset (p. ej. el último padrón mensual). |
| `sunat_obtener_recurso` | Metadata y URL real de descarga de un recurso. |

### Datos

| Tool | Descripción |
|---|---|
| `sunat_perfilar_recurso` | Columnas reales del archivo con tipo inferido, vacíos, valores distintos y ejemplos. **Úsalo antes de filtrar.** |
| `sunat_previsualizar_recurso` | Primeras filas ya parseadas como objetos, con delimitador y encoding detectados. |
| `sunat_buscar_en_recurso` | Filtra filas dentro del archivo **en streaming, sin descargarlo**. Filtros por columna (`igual`, `contiene`, `empieza`, `termina`, `regex`, `mayor`, `menor`) y/o texto libre. |
| `sunat_contar_por_columna` | `GROUP BY` en streaming: cuenta filas por valor de una columna, con filtros previos. |
| `sunat_descargar_recurso` | Descarga el archivo completo a disco (último recurso, rara vez necesario). |
| `sunat_cache` | Estado o limpieza de la caché local del catálogo. |

Flujo típico: `sunat_buscar_recursos` → `sunat_perfilar_recurso` → `sunat_buscar_en_recurso` o
`sunat_contar_por_columna`.

## Particularidades del portal (verificadas contra la API real)

Este portal es CKAN, pero con varias trampas. Todas están resueltas en el código:

- **`package_search` y `organization_list` devuelven 404.** Por eso se navega el grupo de SUNAT con
  `group_package_show` y la búsqueda por palabras clave se hace en cliente.
- **Ante un error el portal responde HTML, no JSON.** Se valida el `content-type` antes de parsear,
  así el fallo dice qué pasó en vez de reventar con un error de sintaxis JSON.
- **`package_show` y `group_package_show` envuelven el resultado en un array de un solo elemento**,
  a diferencia de `package_list`/`resource_show`. Se desenvuelve solo si hace falta.
- **El WAF responde `418` a ciertos User-Agent** (`curl/*`, o cualquiera con una URL entre
  paréntesis). El User-Agent se mantiene como un token simple producto/versión a propósito.
- **El campo `format` miente**: los padrones RUC se declaran `csv` pero se sirven como `.zip`. El
  tipo se decide por los bytes reales (firma `PK`), no por la metadata; cada recurso reporta además
  un `formato_real`.
- **El delimitador varía entre archivos**: `PadronRUC_202209.csv` usa `|` y `PadronRUC_202412.csv`
  usa `,`. Se detecta por archivo, junto con `;` y tabulador.
- **El encoding varía**: el padrón RUC es latin1 y el de agentes de retención es utf-8. Se detecta
  con los primeros bytes, así que `HUÁNUCO` y `ENSEÑANZA` no salen mojibake.

## Uso con Claude Desktop / Claude Code

```json
{
  "mcpServers": {
    "sunat-datos-abiertos": {
      "command": "node",
      "args": ["C:\\source\\mcp-sunat\\build\\index.js"]
    }
  }
}
```

## Uso como CLI

```bash
npm run build
npm link        # instala el comando `sunat` globalmente
```

```bash
sunat list                                   # datasets de SUNAT
sunat search padron ruc 2024-12              # busca recursos por palabras clave
sunat show <dataset>                         # detalle y recursos de un dataset
sunat latest <dataset>                       # el recurso más reciente
sunat resource <resource_id>                 # metadata y URL de un recurso

sunat schema <resource_id>                   # columnas reales, tipos, ejemplos
sunat preview <resource_id> -n 50            # primeras filas parseadas
sunat find <resource_id> -w RUC=20100070970  # busca filas sin descargar el archivo
sunat count <resource_id> Departamento -w Estado=ACTIVO   # group by en streaming

sunat download <resource_id> -o ./padron.zip # descarga completa
sunat cache status | clear | path            # caché local
```

Filtros de `find`/`count` (`-w`, repetible):

| Forma | Significado |
|---|---|
| `columna=valor` | igualdad |
| `columna~valor` | contiene |
| `columna:operador:valor` | `igual`, `contiene`, `empieza`, `termina`, `regex`, `mayor`, `menor` |

Las comparaciones ignoran tildes y mayúsculas (`huanuco` encuentra `HUÁNUCO`).

Flags globales: `--json` (salida cruda para pipes) y `--no-color`.

### Ejemplo real

```
$ sunat find a6892afd-f622-4564-8acd-44644912fcb4 -w RUC=20100070970 \
      -c RUC,Estado,Condicion,Tipo,Departamento
┌─────────────┬────────┬───────────┬──────────────────┬──────────────┐
│ RUC         │ Estado │ Condicion │ Tipo             │ Departamento │
├─────────────┼────────┼───────────┼──────────────────┼──────────────┤
│ 20100070970 │ ACTIVO │ HABIDO    │ SOCIEDAD ANONIMA │ LIMA         │
└─────────────┴────────┴───────────┴──────────────────┴──────────────┘
1 coincidencia(s) | 12,515,483 filas escaneadas | 3.1 GB leidos | escaneo completo: si
```

12.5 millones de filas recorridas, cero bytes escritos en disco. El tiempo lo pone la red
(~3 min con esa conexión), no el parseo.

## Configuración por entorno

| Variable | Efecto |
|---|---|
| `SUNAT_CACHE_DIR` | Carpeta de la caché del catálogo (default `~/.sunat-mcp-cache`). |
| `SUNAT_CACHE_TTL_MS` | TTL de la caché en ms (default 6 h; `0` la desactiva). |
| `SUNAT_MAX_SCAN_BYTES` | Tope de bytes descomprimidos por escaneo (default 6 GB). |
| `SUNAT_DOWNLOAD_DIR` | Carpeta destino por defecto de `sunat_descargar_recurso`. |

Solo se cachea la **metadata** del catálogo (cambia poco). El contenido de los archivos nunca se
cachea, y un resultado que no se pudo interpretar tampoco: así un error puntual del portal no
envenena la caché.

## Límites conocidos

- Un campo entrecomillado que contenga saltos de línea no está soportado (los archivos de este
  portal no los usan; soportarlo obligaría a bufferear filas completas).
- `sunat_contar_por_columna` rechaza columnas con más de 50 000 valores distintos: agrupar por RUC
  no tiene sentido, para eso está `sunat_buscar_en_recurso`.
- `escaneo_completo: false` significa que el conteo es parcial (se cortó por límite de filas, bytes
  o coincidencias). Siempre revisa ese campo antes de afirmar un total.

## Desarrollo

```bash
npm run build   # compila TypeScript a build/
npm start       # corre el servidor MCP compilado
node build/cli.js list   # corre la CLI sin npm link
```

## Licencia

MIT. Ver [LICENSE](LICENSE).
