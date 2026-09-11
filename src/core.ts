import unzipper from "unzipper";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createWriteStream } from "node:fs";
import { mkdir, rm, rename } from "node:fs/promises";
import path from "node:path";
import { conCache } from "./cache.js";
import { fetchJson, abrirDescarga } from "./http.js";
import {
  detectarDelimitador,
  splitCsvLine,
  iterarLineas,
  nuevoEstado,
  normalizar,
  filaAObjeto,
  type Delimitador,
  type Encoding,
} from "./csv.js";

const CKAN_BASE = "https://www.datosabiertos.gob.pe/api/3/action";
const SUNAT_GROUP = "superintendencia-nacional-de-aduanas-y-de-administracion-tributaria-sunat";

/**
 * Tope de bytes descomprimidos por escaneo. El padron RUC descomprimido pasa los
 * 2.9 GB y viene ordenado por RUC ascendente, asi que un tope bajo nunca llega a
 * los RUC de empresa (20...). Se lee en streaming y se descarta, no se guarda nada.
 */
const MAX_BYTES_ESCANEO = (() => {
  const env = Number(process.env.SUNAT_MAX_SCAN_BYTES);
  return Number.isFinite(env) && env > 0 ? env : 6 * 1024 * 1024 * 1024;
})();
const MAX_FILAS_ESCANEO = 20_000_000;

export interface CkanResource {
  id: string;
  name: string;
  format: string;
  url: string;
  description?: string | null;
  mimetype?: string | null;
  last_modified?: string | null;
  created?: string | null;
  size?: string | null;
}

export interface CkanPackage {
  name: string;
  title: string;
  notes?: string;
  metadata_modified?: string;
  resources: CkanResource[];
}

async function ckan<T>(action: string, params: Record<string, string> = {}): Promise<T> {
  const url = new URL(`${CKAN_BASE}/${action}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);

  const body = await fetchJson<{ success: boolean; result: T; error?: unknown }>(url.toString());
  if (!body.success) {
    throw new Error(`CKAN ${action} fallo: ${JSON.stringify(body.error)}`);
  }
  return body.result;
}

/**
 * package_show y group_package_show de este portal envuelven el resultado en un array
 * de un solo elemento, a diferencia del CKAN estandar. Se desenvuelve solo si la forma
 * recibida no es ya la esperada, para no romperse si el portal se normaliza algun dia.
 */
async function ckanShow<T>(
  action: string,
  params: Record<string, string>,
  esperado: "objeto" | "lista"
): Promise<T> {
  const result = await ckan<unknown>(action, params);
  const yaEsLaForma = esperado === "lista" ? Array.isArray(result) && !Array.isArray(result[0]) : !Array.isArray(result);

  if (yaEsLaForma) return result as T;
  if (Array.isArray(result) && result.length === 1) return result[0] as T;

  throw new Error(`Respuesta inesperada de CKAN en ${action}: no se pudo interpretar el resultado.`);
}

function cacheKey(action: string, params: Record<string, string>): string {
  return `${action}:${JSON.stringify(params)}`;
}

async function paquetesSunat(): Promise<CkanPackage[]> {
  return conCache(cacheKey("group_package_show", { id: SUNAT_GROUP }), () =>
    ckanShow<CkanPackage[]>("group_package_show", { id: SUNAT_GROUP }, "lista")
  );
}

async function paquete(dataset: string): Promise<CkanPackage> {
  return conCache(cacheKey("package_show", { id: dataset }), () =>
    ckanShow<CkanPackage>("package_show", { id: dataset }, "objeto")
  );
}

async function recursoCrudo(resourceId: string): Promise<CkanResource> {
  return conCache(cacheKey("resource_show", { id: resourceId }), () =>
    ckan<CkanResource>("resource_show", { id: resourceId })
  );
}

function limpiarHtml(texto: string | null | undefined): string | null {
  return (texto ?? "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim() || null;
}

function esZipResource(r: CkanResource): boolean {
  const url = r.url.toLowerCase();
  return url.endsWith(".zip") || url.includes(".zip?") || (r.mimetype ?? "").toLowerCase().includes("zip");
}

function nombreDesdeUrl(url: string): string | null {
  try {
    return path.basename(new URL(url).pathname) || null;
  } catch {
    return null;
  }
}

/**
 * El campo `format` de CKAN miente en este portal: el padron RUC se declara "csv"
 * pero se sirve como zip. Se prioriza la extension real de la URL y el mimetype.
 */
function formatoReal(r: CkanResource): string {
  if (esZipResource(r)) return "zip";
  const ext = path.extname(nombreDesdeUrl(r.url) ?? "").replace(".", "").toLowerCase();
  return ext || r.format.toLowerCase();
}

export function resourceSummary(r: CkanResource) {
  return {
    id: r.id,
    nombre: r.name,
    formato: formatoReal(r),
    formato_declarado: r.format,
    tamano: r.size ?? null,
    ultima_modificacion: r.last_modified ?? r.created ?? null,
  };
}

// ---------------------------------------------------------------- datasets

export interface DatasetResumen {
  dataset: string;
  titulo: string;
  cantidad_recursos: number;
  ultima_modificacion: string | null;
}

export async function listarDatasets(): Promise<DatasetResumen[]> {
  const packages = await paquetesSunat();
  return packages.map((p) => ({
    dataset: p.name,
    titulo: p.title.trim(),
    cantidad_recursos: p.resources.length,
    ultima_modificacion: p.metadata_modified ?? null,
  }));
}

export interface DatasetDetalle {
  dataset: string;
  titulo: string;
  descripcion: string | null;
  recursos: ReturnType<typeof resourceSummary>[];
}

export async function obtenerDataset(dataset: string): Promise<DatasetDetalle> {
  const pkg = await paquete(dataset);
  return {
    dataset: pkg.name,
    titulo: pkg.title.trim(),
    descripcion: limpiarHtml(pkg.notes),
    recursos: pkg.resources.map(resourceSummary),
  };
}

export interface RecursoEncontrado {
  id: string;
  nombre: string;
  dataset: string;
  dataset_titulo: string;
  formato: string;
  tamano: string | null;
  ultima_modificacion: string | null;
  puntaje: number;
}

/**
 * Busqueda local sobre el catalogo. package_search del portal devuelve 404, y el
 * padron RUC solo tiene ~57 recursos con nombres tipo "Padron RUC 2024-03", asi que
 * filtrar en cliente alcanza y evita volcar el catalogo entero en el contexto.
 */
export async function buscarRecursos(consulta: string, limite = 25): Promise<RecursoEncontrado[]> {
  const terminos = normalizar(consulta).split(/\s+/).filter(Boolean);
  if (terminos.length === 0) throw new Error("La consulta de busqueda no puede estar vacia.");

  const packages = await paquetesSunat();
  const encontrados: RecursoEncontrado[] = [];

  for (const pkg of packages) {
    const textoPkg = normalizar(`${pkg.name} ${pkg.title}`);
    for (const r of pkg.resources) {
      const textoRecurso = normalizar(`${r.name} ${r.description ?? ""} ${r.url}`);

      // AND, no OR: todos los terminos tienen que aparecer en algun lado.
      if (!terminos.every((t) => textoRecurso.includes(t) || textoPkg.includes(t))) continue;

      const puntaje = terminos.reduce((acc, t) => acc + (textoRecurso.includes(t) ? 2 : 1), 0);
      encontrados.push({
        id: r.id,
        nombre: r.name,
        dataset: pkg.name,
        dataset_titulo: pkg.title.trim(),
        formato: formatoReal(r),
        tamano: r.size ?? null,
        ultima_modificacion: r.last_modified ?? r.created ?? null,
        puntaje,
      });
    }
  }

  return encontrados
    .sort((a, b) => b.puntaje - a.puntaje || b.nombre.localeCompare(a.nombre))
    .slice(0, Math.max(1, limite));
}

/** El recurso mas reciente de un dataset, resolviendo por el periodo del nombre. */
export async function recursoMasReciente(dataset: string): Promise<ReturnType<typeof resourceSummary>> {
  const pkg = await paquete(dataset);
  if (pkg.resources.length === 0) throw new Error(`El dataset '${dataset}' no tiene recursos.`);

  const conOrden = pkg.resources.map((r) => {
    const periodo = r.name.match(/(\d{4})[-_/ ]?(\d{2})/);
    const clave = periodo ? Number(periodo[1]) * 100 + Number(periodo[2]) : 0;
    const fecha = Date.parse(r.last_modified ?? r.created ?? "") || 0;
    return { r, clave, fecha };
  });

  conOrden.sort((a, b) => b.clave - a.clave || b.fecha - a.fecha);
  return resourceSummary(conOrden[0].r);
}

// ---------------------------------------------------------------- recursos

export interface RecursoInfo {
  id: string;
  nombre: string;
  descripcion: string | null;
  url_descarga: string;
  formato_declarado: string;
  formato_real: string;
  mimetype: string | null;
  tamano: string | null;
  ultima_modificacion: string | null;
  es_zip: boolean;
}

export async function obtenerRecurso(resourceId: string): Promise<RecursoInfo> {
  const r = await recursoCrudo(resourceId);
  return {
    id: r.id,
    nombre: r.name,
    descripcion: limpiarHtml(r.description),
    url_descarga: r.url,
    formato_declarado: r.format,
    formato_real: formatoReal(r),
    mimetype: r.mimetype ?? null,
    tamano: r.size ?? null,
    ultima_modificacion: r.last_modified ?? r.created ?? null,
    es_zip: esZipResource(r),
  };
}

// ------------------------------------------------------- apertura del csv

const FIRMA_ZIP = Buffer.from([0x50, 0x4b]); // "PK"

/** Lee el primer chunk sin consumirlo: se devuelve al stream con unshift. */
function espiarInicio(stream: Readable): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const limpiar = () => {
      stream.off("readable", onReadable);
      stream.off("end", onEnd);
      stream.off("error", onError);
    };
    const onReadable = () => {
      const chunk = stream.read();
      if (chunk) {
        limpiar();
        resolve(chunk as Buffer);
      }
    };
    const onEnd = () => {
      limpiar();
      resolve(Buffer.alloc(0));
    };
    const onError = (err: Error) => {
      limpiar();
      reject(err);
    };
    stream.on("readable", onReadable);
    stream.on("end", onEnd);
    stream.on("error", onError);
  });
}

interface FlujoCsv {
  bytes: AsyncIterable<Uint8Array>;
  archivo: string | null;
  esZip: boolean;
  cerrar: () => void;
  /** Lanza si el stream murio a mitad de lectura, en vez de devolver un resultado corto. */
  verificar: () => void;
}

/**
 * Abre el contenido tabular de un recurso, sea csv suelto o csv dentro de un zip.
 * El tipo se decide por los bytes reales (firma PK), no por el campo `format` de
 * CKAN, que en este portal no es confiable.
 */
async function abrirCsv(r: CkanResource, archivoDeseado?: string): Promise<FlujoCsv> {
  const controlador = new AbortController();
  const res = await abrirDescarga(r.url, controlador.signal);

  const nodeStream = Readable.fromWeb(res.body as import("node:stream/web").ReadableStream<Uint8Array>);

  // Cerrar a mitad de lectura es lo normal aca (se corta apenas hay suficientes
  // filas). Destruir el stream hace que el parser y el fetch emitan AbortError; sin
  // un listener de error eso tumba el proceso entero. Pero tragarselos sin mas
  // convierte un corte de red en un resultado vacio que parece legitimo, asi que el
  // primer error anterior al cierre deliberado se guarda y lo relanza verificar().
  let primerError: Error | null = null;
  let cerrado = false;
  const absorber = (s: NodeJS.EventEmitter) =>
    s.on("error", (err: Error) => {
      if (!cerrado && !primerError) primerError = err;
    });
  const verificar = () => {
    if (primerError) throw new Error(`La lectura del recurso se interrumpio: ${primerError.message}`);
  };
  absorber(nodeStream);

  const porCerrar: NodeJS.EventEmitter[] = [nodeStream];
  const cerrar = () => {
    if (cerrado) return;
    cerrado = true;
    for (const s of porCerrar) (s as { destroy?: () => void }).destroy?.();
    controlador.abort();
  };

  let inicio: Buffer;
  try {
    inicio = await espiarInicio(nodeStream);
  } catch (err) {
    cerrar();
    throw err;
  }

  const esZip = inicio.subarray(0, 2).equals(FIRMA_ZIP);
  if (inicio.length > 0) nodeStream.unshift(inicio);

  if (!esZip) {
    return { bytes: nodeStream, archivo: nombreDesdeUrl(r.url), esZip: false, cerrar, verificar };
  }

  const zip = nodeStream.pipe(unzipper.Parse({ forceStream: true }));
  absorber(zip);
  porCerrar.push(zip);
  const deseado = archivoDeseado ? normalizar(archivoDeseado) : null;
  const vistos: string[] = [];

  // Por eventos y no con `for await`: salir del bucle con return invoca el
  // .return() del iterador, que destruye el parser y con el la entrada que
  // justamente ibamos a devolver (quedaba un stream que nunca emitia nada).
  // El evento tiene que ser "data", no "entry": con forceStream el parser es un
  // stream en modo objeto y solo avanza si alguien lo consume; con un listener de
  // "entry" se queda pausado para siempre.
  const entrada = await new Promise<unzipper.Entry>((resolve, reject) => {
    const limpiar = () => {
      zip.off("data", onEntry);
      zip.off("error", onError);
      zip.off("end", onFin);
      zip.off("close", onFin);
    };
    const onEntry = (entry: unzipper.Entry) => {
      const nombre = entry.path;
      const coincide = deseado ? normalizar(nombre).includes(deseado) : /\.(csv|txt|tsv)$/i.test(nombre);
      if (entry.type === "File" && coincide) {
        // El parser se queda a la espera hasta que se consuma esta entrada.
        limpiar();
        resolve(entry);
        return;
      }
      vistos.push(nombre);
      entry.autodrain();
    };
    const onError = (err: Error) => {
      limpiar();
      reject(err);
    };
    const onFin = () => {
      limpiar();
      const pista = vistos.length ? ` Entradas del zip: ${vistos.slice(0, 10).join(", ")}.` : "";
      reject(
        new Error(
          deseado
            ? `El zip no contiene ninguna entrada que coincida con '${archivoDeseado}'.${pista}`
            : `El zip no contiene ningun archivo .csv/.txt/.tsv.${pista}`
        )
      );
    };

    zip.on("data", onEntry);
    zip.on("error", onError);
    zip.on("end", onFin);
    zip.on("close", onFin);
  }).catch((err) => {
    cerrar();
    throw err;
  });

  absorber(entrada);
  porCerrar.unshift(entrada);

  // El parser tiene que seguir consumiendose despues de entregar la entrada: si su
  // stream de objetos queda pausado, la entrada nunca emite 'end' al terminar el
  // archivo y el lector se queda esperando para siempre. Las entradas siguientes se
  // descartan, ya solo nos interesa esta.
  zip.on("data", (siguiente: unzipper.Entry) => siguiente.autodrain());

  return { bytes: entrada as unknown as AsyncIterable<Uint8Array>, archivo: entrada.path, esZip: true, cerrar, verificar };
}

/** Lee el encabezado de un flujo ya abierto y deja listo el delimitador. */
function leerEncabezado(linea: string): { columnas: string[]; delimitador: Delimitador } {
  const delimitador = detectarDelimitador(linea);
  return { columnas: splitCsvLine(linea, delimitador).map((c) => c.trim()), delimitador };
}

// ------------------------------------------------------- previsualizacion

export interface PrevisualizacionRecurso {
  recurso: string;
  archivo: string | null;
  es_zip: boolean;
  delimitador: Delimitador;
  encoding: Encoding;
  columnas: string[];
  filas: Record<string, string>[];
  bytes_leidos: number;
  nota: string;
}

export async function previsualizarRecurso(
  resourceId: string,
  filas: number,
  archivo?: string
): Promise<PrevisualizacionRecurso> {
  const limite = Math.min(Math.max(filas, 1), 500);
  const r = await recursoCrudo(resourceId);
  const flujo = await abrirCsv(r, archivo);
  const estado = nuevoEstado();

  let columnas: string[] = [];
  let delimitador: Delimitador = ",";
  const datos: Record<string, string>[] = [];

  try {
    for await (const linea of iterarLineas(flujo.bytes, { maxBytes: 16 * 1024 * 1024, estado })) {
      if (linea.trim() === "") continue;
      if (columnas.length === 0) {
        ({ columnas, delimitador } = leerEncabezado(linea));
        continue;
      }
      datos.push(filaAObjeto(columnas, splitCsvLine(linea, delimitador)));
      if (datos.length >= limite) break;
    }
    flujo.verificar();
  } finally {
    flujo.cerrar();
  }

  return {
    recurso: r.name,
    archivo: flujo.archivo,
    es_zip: flujo.esZip,
    delimitador,
    encoding: estado.encoding ?? "utf-8",
    columnas,
    filas: datos,
    bytes_leidos: estado.bytesLeidos,
    nota:
      "Previsualizacion parcial: solo se leyo el inicio del archivo. Para filtrar el archivo " +
      "completo sin descargarlo, usa sunat_buscar_en_recurso.",
  };
}

// ------------------------------------------------------- busqueda en datos

export type Operador = "igual" | "contiene" | "empieza" | "termina" | "regex" | "mayor" | "menor";

export interface Filtro {
  columna: string;
  operador: Operador;
  valor: string;
}

export interface OpcionesBusquedaFilas {
  filtros?: Filtro[];
  texto?: string;
  columnas?: string[];
  limite?: number;
  maxFilas?: number;
  maxBytes?: number;
  archivo?: string;
}

export interface ResultadoBusquedaFilas {
  recurso: string;
  archivo: string | null;
  delimitador: Delimitador;
  encoding: Encoding;
  columnas: string[];
  filas: Record<string, string>[];
  coincidencias: number;
  filas_escaneadas: number;
  bytes_leidos: number;
  escaneo_completo: boolean;
  nota: string;
}

function indiceColumna(columnas: string[], nombre: string): number {
  const i = columnas.findIndex((c) => normalizar(c) === normalizar(nombre));
  if (i === -1) {
    throw new Error(`La columna '${nombre}' no existe. Columnas disponibles: ${columnas.join(", ")}`);
  }
  return i;
}

function compilarFiltro(filtro: Filtro, columnas: string[]): (campos: string[]) => boolean {
  const idx = indiceColumna(columnas, filtro.columna);
  const valorNorm = normalizar(filtro.valor);

  switch (filtro.operador) {
    case "igual":
      return (campos) => normalizar(campos[idx] ?? "") === valorNorm;
    case "contiene":
      return (campos) => normalizar(campos[idx] ?? "").includes(valorNorm);
    case "empieza":
      return (campos) => normalizar(campos[idx] ?? "").startsWith(valorNorm);
    case "termina":
      return (campos) => normalizar(campos[idx] ?? "").endsWith(valorNorm);
    case "regex": {
      let re: RegExp;
      try {
        re = new RegExp(filtro.valor, "i");
      } catch (err) {
        throw new Error(`Regex invalida en el filtro de '${filtro.columna}': ${(err as Error).message}`);
      }
      return (campos) => re.test(campos[idx] ?? "");
    }
    case "mayor":
    case "menor": {
      const n = Number(filtro.valor);
      if (!Number.isFinite(n)) {
        throw new Error(`El operador '${filtro.operador}' necesita un valor numerico, recibio '${filtro.valor}'.`);
      }
      return filtro.operador === "mayor"
        ? (campos) => Number(campos[idx]) > n
        : (campos) => Number(campos[idx]) < n;
    }
  }
}

/**
 * Filtra filas leyendo el archivo en streaming y cortando apenas junta `limite`
 * coincidencias. Nunca guarda nada en disco ni carga el archivo en memoria: asi se
 * puede consultar un padron de 2.9 GB descomprimidos sin bajarlo.
 */
export async function buscarEnRecurso(
  resourceId: string,
  opts: OpcionesBusquedaFilas = {}
): Promise<ResultadoBusquedaFilas> {
  const limite = Math.min(Math.max(opts.limite ?? 50, 1), 1000);
  const maxFilas = Math.min(opts.maxFilas ?? MAX_FILAS_ESCANEO, MAX_FILAS_ESCANEO);
  const maxBytes = Math.min(opts.maxBytes ?? MAX_BYTES_ESCANEO, MAX_BYTES_ESCANEO);
  const textoNorm = opts.texto?.trim() ? normalizar(opts.texto) : null;
  const filtros = opts.filtros ?? [];

  if (!textoNorm && filtros.length === 0) {
    throw new Error("Hay que indicar al menos un filtro por columna o un texto libre a buscar.");
  }

  const r = await recursoCrudo(resourceId);
  const flujo = await abrirCsv(r, opts.archivo);
  const estado = nuevoEstado();

  let columnas: string[] = [];
  let delimitador: Delimitador = ",";
  let predicados: ((campos: string[]) => boolean)[] = [];
  let proyeccion: number[] | null = null;
  let escaneadas = 0;
  let coincidencias = 0;
  let cortadoPorLimite = false;
  const filas: Record<string, string>[] = [];

  try {
    for await (const linea of iterarLineas(flujo.bytes, { maxBytes, estado })) {
      if (linea.trim() === "") continue;

      if (columnas.length === 0) {
        ({ columnas, delimitador } = leerEncabezado(linea));
        predicados = filtros.map((f) => compilarFiltro(f, columnas));
        proyeccion = opts.columnas?.length ? opts.columnas.map((n) => indiceColumna(columnas, n)) : null;
        continue;
      }

      escaneadas++;

      // El texto libre se evalua sobre la linea cruda: es mucho mas barato que
      // partir en campos, y descarta la mayoria de filas antes del split.
      if (textoNorm && !normalizar(linea).includes(textoNorm)) {
        if (escaneadas >= maxFilas) break;
        continue;
      }

      let campos: string[] | null = null;
      let pasa = true;
      if (predicados.length > 0) {
        campos = splitCsvLine(linea, delimitador);
        pasa = predicados.every((p) => p(campos as string[]));
      }

      if (pasa) {
        coincidencias++;
        campos ??= splitCsvLine(linea, delimitador);
        const cabecera = proyeccion ? proyeccion.map((i) => columnas[i]) : columnas;
        const valores = proyeccion ? proyeccion.map((i) => campos![i] ?? "") : campos;
        filas.push(filaAObjeto(cabecera, valores));
        if (filas.length >= limite) {
          cortadoPorLimite = true;
          break;
        }
      }

      if (escaneadas >= maxFilas) break;
    }
    flujo.verificar();
  } finally {
    flujo.cerrar();
  }

  const completo = !cortadoPorLimite && !estado.truncado && escaneadas < maxFilas;

  return {
    recurso: r.name,
    archivo: flujo.archivo,
    delimitador,
    encoding: estado.encoding ?? "utf-8",
    columnas: proyeccion ? proyeccion.map((i) => columnas[i]) : columnas,
    filas,
    coincidencias,
    filas_escaneadas: escaneadas,
    bytes_leidos: estado.bytesLeidos,
    escaneo_completo: completo,
    nota: completo
      ? "Se escaneo el archivo completo: el conteo de coincidencias es exacto."
      : cortadoPorLimite
        ? `Se corto al juntar ${limite} filas; puede haber mas coincidencias mas adelante en el archivo.`
        : "Se corto por el limite de escaneo (bytes o filas): el resultado es parcial.",
  };
}

// ------------------------------------------------------------ agregacion

export interface ConteoValor {
  valor: string;
  filas: number;
}

export interface ResultadoConteo {
  recurso: string;
  columna: string;
  valores: ConteoValor[];
  valores_distintos: number;
  filas_escaneadas: number;
  escaneo_completo: boolean;
  nota: string;
}

/**
 * Cuenta filas por valor de una columna (group by) en streaming. Util para preguntas
 * tipo "cuantos contribuyentes ACTIVOS hay por departamento" sin bajar el archivo.
 */
export async function contarPorColumna(
  resourceId: string,
  columna: string,
  opts: { filtros?: Filtro[]; top?: number; maxFilas?: number; maxBytes?: number; archivo?: string } = {}
): Promise<ResultadoConteo> {
  const top = Math.min(Math.max(opts.top ?? 50, 1), 1000);
  const maxFilas = Math.min(opts.maxFilas ?? MAX_FILAS_ESCANEO, MAX_FILAS_ESCANEO);
  const maxBytes = Math.min(opts.maxBytes ?? MAX_BYTES_ESCANEO, MAX_BYTES_ESCANEO);

  const r = await recursoCrudo(resourceId);
  const flujo = await abrirCsv(r, opts.archivo);
  const estado = nuevoEstado();

  const conteos = new Map<string, number>();
  let columnas: string[] = [];
  let delimitador: Delimitador = ",";
  let idx = -1;
  let predicados: ((campos: string[]) => boolean)[] = [];
  let escaneadas = 0;

  try {
    for await (const linea of iterarLineas(flujo.bytes, { maxBytes, estado })) {
      if (linea.trim() === "") continue;

      if (columnas.length === 0) {
        ({ columnas, delimitador } = leerEncabezado(linea));
        idx = indiceColumna(columnas, columna);
        predicados = (opts.filtros ?? []).map((f) => compilarFiltro(f, columnas));
        continue;
      }

      escaneadas++;
      const campos = splitCsvLine(linea, delimitador);
      if (!predicados.every((p) => p(campos))) {
        if (escaneadas >= maxFilas) break;
        continue;
      }

      const valor = (campos[idx] ?? "").trim() || "(vacio)";
      conteos.set(valor, (conteos.get(valor) ?? 0) + 1);

      // Cardinalidad desbocada: una columna tipo RUC no se agrupa, se corta.
      if (conteos.size > 50_000) {
        throw new Error(
          `La columna '${columna}' tiene demasiados valores distintos para agrupar (>50000). ` +
            "Usa sunat_buscar_en_recurso con filtros en vez de contar por esta columna."
        );
      }
      if (escaneadas >= maxFilas) break;
    }
    flujo.verificar();
  } finally {
    flujo.cerrar();
  }

  const completo = !estado.truncado && escaneadas < maxFilas;
  const valores = [...conteos.entries()]
    .map(([valor, filas]) => ({ valor, filas }))
    .sort((a, b) => b.filas - a.filas)
    .slice(0, top);

  return {
    recurso: r.name,
    columna: columnas[idx] ?? columna,
    valores,
    valores_distintos: conteos.size,
    filas_escaneadas: escaneadas,
    escaneo_completo: completo,
    nota: completo
      ? "Conteo sobre el archivo completo."
      : "Conteo parcial: se corto por el limite de escaneo (bytes o filas).",
  };
}

// ------------------------------------------------------------ perfilado

export interface PerfilColumna {
  columna: string;
  tipo_inferido: "entero" | "decimal" | "fecha" | "texto" | "vacio";
  vacios: number;
  valores_distintos: number | string;
  ejemplos: string[];
  longitud_max: number;
}

export interface PerfilRecurso {
  recurso: string;
  archivo: string | null;
  delimitador: Delimitador;
  encoding: Encoding;
  filas_analizadas: number;
  columnas: PerfilColumna[];
  nota: string;
}

const MAX_DISTINTOS = 200;

function inferirTipo(ejemplos: string[]): PerfilColumna["tipo_inferido"] {
  const utiles = ejemplos.filter((v) => v !== "");
  if (utiles.length === 0) return "vacio";
  if (utiles.every((v) => /^-?\d+$/.test(v))) return "entero";
  if (utiles.every((v) => /^-?\d+[.,]\d+$/.test(v))) return "decimal";
  if (utiles.every((v) => /^\d{4}[-/]?\d{2}([-/]?\d{2})?$/.test(v))) return "fecha";
  return "texto";
}

/**
 * Perfila el esquema real del archivo con una muestra: columnas, tipos, vacios y
 * valores de ejemplo. Sirve para saber por que columna filtrar antes de lanzar una
 * busqueda sobre cientos de MB.
 */
export async function perfilarRecurso(
  resourceId: string,
  filasMuestra = 5000,
  archivo?: string
): Promise<PerfilRecurso> {
  const muestra = Math.min(Math.max(filasMuestra, 10), 100_000);
  const r = await recursoCrudo(resourceId);
  const flujo = await abrirCsv(r, archivo);
  const estado = nuevoEstado();

  let columnas: string[] = [];
  let delimitador: Delimitador = ",";
  let analizadas = 0;
  const distintos: Set<string>[] = [];
  const vacios: number[] = [];
  const longitudMax: number[] = [];
  const ejemplos: string[][] = [];

  try {
    for await (const linea of iterarLineas(flujo.bytes, { maxBytes: 64 * 1024 * 1024, estado })) {
      if (linea.trim() === "") continue;

      if (columnas.length === 0) {
        ({ columnas, delimitador } = leerEncabezado(linea));
        for (let i = 0; i < columnas.length; i++) {
          distintos.push(new Set());
          vacios.push(0);
          longitudMax.push(0);
          ejemplos.push([]);
        }
        continue;
      }

      const campos = splitCsvLine(linea, delimitador);
      for (let i = 0; i < columnas.length; i++) {
        const v = (campos[i] ?? "").trim();
        if (v === "") {
          vacios[i]++;
          continue;
        }
        if (distintos[i].size < MAX_DISTINTOS) distintos[i].add(v);
        if (v.length > longitudMax[i]) longitudMax[i] = v.length;
        if (ejemplos[i].length < 5 && !ejemplos[i].includes(v)) ejemplos[i].push(v);
      }

      analizadas++;
      if (analizadas >= muestra) break;
    }
    flujo.verificar();
  } finally {
    flujo.cerrar();
  }

  return {
    recurso: r.name,
    archivo: flujo.archivo,
    delimitador,
    encoding: estado.encoding ?? "utf-8",
    filas_analizadas: analizadas,
    columnas: columnas.map((c, i) => ({
      columna: c,
      tipo_inferido: inferirTipo(ejemplos[i] ?? []),
      vacios: vacios[i] ?? 0,
      valores_distintos: (distintos[i]?.size ?? 0) >= MAX_DISTINTOS ? `${MAX_DISTINTOS}+` : (distintos[i]?.size ?? 0),
      ejemplos: ejemplos[i] ?? [],
      longitud_max: longitudMax[i] ?? 0,
    })),
    nota: `Perfil calculado sobre las primeras ${analizadas} filas, no sobre el archivo completo.`,
  };
}

// ------------------------------------------------------------ descarga

export interface DescargaResultado {
  path: string;
  bytes: number;
  es_zip: boolean;
  url_origen: string;
}

function extensionDe(res: Response, r: CkanResource): string {
  const disp = res.headers.get("content-disposition") ?? "";
  const m = disp.match(/filename\*?=(?:UTF-8'')?"?([^";]+)"?/i);
  const ext = path.extname(m?.[1] ?? nombreDesdeUrl(r.url) ?? "");
  if (ext) return ext;
  return esZipResource(r) ? ".zip" : ".csv";
}

/**
 * Descarga el recurso completo a disco. Escribe a un `.part` y renombra al final:
 * una descarga interrumpida no deja un archivo truncado con nombre definitivo.
 */
export async function descargarRecurso(
  resourceId: string,
  destino: string,
  onProgress?: (bytes: number, total: number | null) => void
): Promise<DescargaResultado> {
  const r = await recursoCrudo(resourceId);
  const res = await abrirDescarga(r.url);

  const totalHeader = res.headers.get("content-length");
  const total = totalHeader && Number.isFinite(Number(totalHeader)) ? Number(totalHeader) : null;

  // Sin extension el archivo queda inusable (un zip llamado "a1b2c3" sin mas).
  const rutaFinal = path.extname(destino) ? destino : destino + extensionDe(res, r);
  const parcial = `${rutaFinal}.part`;
  await mkdir(path.dirname(path.resolve(rutaFinal)), { recursive: true });

  let bytes = 0;
  const nodeStream = Readable.fromWeb(res.body as import("node:stream/web").ReadableStream<Uint8Array>);
  nodeStream.on("data", (chunk: Buffer) => {
    bytes += chunk.length;
    onProgress?.(bytes, total);
  });

  try {
    await pipeline(nodeStream, createWriteStream(parcial));
    if (total !== null && bytes !== total) {
      throw new Error(`Descarga incompleta: se recibieron ${bytes} de ${total} bytes.`);
    }
    await rename(parcial, rutaFinal);
  } catch (err) {
    await rm(parcial, { force: true }).catch(() => {});
    throw err;
  }

  return { path: path.resolve(rutaFinal), bytes, es_zip: esZipResource(r), url_origen: r.url };
}
