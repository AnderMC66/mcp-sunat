export type Encoding = "utf-8" | "latin1";

/** Delimitadores candidatos, en orden de preferencia ante empate. */
const DELIMITADORES = ["|", ";", "\t", ","] as const;
export type Delimitador = (typeof DELIMITADORES)[number];

/**
 * Los csv de SUNAT usan "|" (verificado contra PadronRUC_*.csv), pero otros recursos
 * del portal usan ";" o ",". Se elige el delimitador que mas veces aparece fuera de comillas.
 */
export function detectarDelimitador(encabezado: string): Delimitador {
  let mejor: Delimitador = ",";
  let mejorConteo = 0;
  for (const d of DELIMITADORES) {
    const conteo = splitCsvLine(encabezado, d).length - 1;
    if (conteo > mejorConteo) {
      mejorConteo = conteo;
      mejor = d;
    }
  }
  return mejor;
}

/**
 * Split respetando comillas dobles al estilo RFC 4180 ("" escapa una comilla).
 * No soporta saltos de linea dentro de un campo entrecomillado: los archivos de
 * este portal no los usan y soportarlo obligaria a bufferear filas completas.
 */
export function splitCsvLine(linea: string, delim: string): string[] {
  if (!linea.includes('"')) return linea.split(delim);

  const campos: string[] = [];
  let actual = "";
  let enComillas = false;

  for (let i = 0; i < linea.length; i++) {
    const ch = linea[i];
    if (enComillas) {
      if (ch === '"') {
        if (linea[i + 1] === '"') {
          actual += '"';
          i++;
        } else {
          enComillas = false;
        }
      } else {
        actual += ch;
      }
    } else if (ch === '"') {
      enComillas = true;
    } else if (ch === delim) {
      campos.push(actual);
      actual = "";
    } else {
      actual += ch;
    }
  }
  campos.push(actual);
  return campos;
}

/**
 * utf-8 si el muestreo decodifica sin errores, latin1 (windows-1252) si no.
 * El muestreo se recorta al ultimo salto de linea para no cortar un caracter
 * multibyte por la mitad y confundirlo con latin1.
 */
export function detectarEncoding(muestra: Buffer): Encoding {
  if (muestra.length >= 3 && muestra[0] === 0xef && muestra[1] === 0xbb && muestra[2] === 0xbf) {
    return "utf-8";
  }
  const corte = muestra.lastIndexOf(0x0a);
  const probe = corte > 0 ? muestra.subarray(0, corte) : muestra;
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(probe);
    return "utf-8";
  } catch {
    return "latin1";
  }
}

class Decodificador {
  private readonly utf8 = new TextDecoder("utf-8");
  constructor(private readonly encoding: Encoding) {}
  decode(buf: Buffer): string {
    // latin1 es byte-por-caracter, no hay estado entre chunks.
    return this.encoding === "latin1" ? buf.toString("latin1") : this.utf8.decode(buf, { stream: true });
  }
}

export interface EstadoLectura {
  encoding: Encoding | null;
  bytesLeidos: number;
  truncado: boolean;
}

export function nuevoEstado(): EstadoLectura {
  return { encoding: null, bytesLeidos: 0, truncado: false };
}

const MUESTRA_ENCODING_BYTES = 8192;

/**
 * Itera lineas completas de un stream binario sin cargarlo en memoria.
 * Detecta el encoding con los primeros bytes y corta en `maxBytes` marcando
 * `estado.truncado`. Nunca emite una linea parcial salvo al final real del stream.
 */
export async function* iterarLineas(
  stream: AsyncIterable<Uint8Array>,
  opts: { maxBytes?: number; encoding?: Encoding; estado?: EstadoLectura } = {}
): AsyncGenerator<string, void, undefined> {
  const maxBytes = opts.maxBytes ?? Number.POSITIVE_INFINITY;
  const estado = opts.estado ?? nuevoEstado();

  let dec: Decodificador | null = null;
  if (opts.encoding) {
    estado.encoding = opts.encoding;
    dec = new Decodificador(opts.encoding);
  }

  let muestra: Buffer[] = [];
  let muestraLen = 0;
  let pendiente = "";

  const emitir = function* (texto: string): Generator<string> {
    let idx: number;
    while ((idx = texto.indexOf("\n")) !== -1) {
      const linea = texto.slice(0, idx);
      texto = texto.slice(idx + 1);
      yield linea.endsWith("\r") ? linea.slice(0, -1) : linea;
    }
    pendiente = texto;
  };

  for await (const raw of stream) {
    const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
    estado.bytesLeidos += chunk.length;

    if (!dec) {
      muestra.push(chunk);
      muestraLen += chunk.length;
      if (muestraLen < MUESTRA_ENCODING_BYTES && estado.bytesLeidos < maxBytes) continue;
      const probe = Buffer.concat(muestra);
      muestra = [];
      estado.encoding = detectarEncoding(probe);
      dec = new Decodificador(estado.encoding);
      yield* emitir(pendiente + quitarBom(dec.decode(probe)));
    } else {
      yield* emitir(pendiente + dec.decode(chunk));
    }

    if (estado.bytesLeidos >= maxBytes) {
      estado.truncado = true;
      break;
    }
  }

  // El stream acabo antes de llenar el muestreo de encoding.
  if (!dec && muestraLen > 0) {
    const probe = Buffer.concat(muestra);
    estado.encoding = detectarEncoding(probe);
    dec = new Decodificador(estado.encoding);
    yield* emitir(pendiente + quitarBom(dec.decode(probe)));
  }

  // Ultima linea sin salto final: solo es completa si no cortamos por limite de bytes.
  if (pendiente.length > 0 && !estado.truncado) {
    yield pendiente.endsWith("\r") ? pendiente.slice(0, -1) : pendiente;
  }
}

function quitarBom(texto: string): string {
  return texto.charCodeAt(0) === 0xfeff ? texto.slice(1) : texto;
}

/** Normaliza para comparar sin tildes ni mayusculas (HUANUCO === Huánuco). */
export function normalizar(texto: string): string {
  return texto
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .trim();
}

/** Empareja una fila (array de campos) con su encabezado, tolerando filas cortas o largas. */
export function filaAObjeto(encabezado: string[], campos: string[]): Record<string, string> {
  const obj: Record<string, string> = {};
  for (let i = 0; i < encabezado.length; i++) {
    obj[encabezado[i] || `columna_${i + 1}`] = (campos[i] ?? "").trim();
  }
  for (let i = encabezado.length; i < campos.length; i++) {
    obj[`extra_${i + 1}`] = (campos[i] ?? "").trim();
  }
  return obj;
}
