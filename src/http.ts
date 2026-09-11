// El WAF del portal responde 418 a varios User-Agent (curl/*, o cualquiera con una
// URL entre parentesis). Un token simple producto/version pasa; no lo adornes.
const USER_AGENT = "sunat-datos-abiertos-mcp/2.0";

/** Timeout por request a la API de metadatos (CKAN). */
const TIMEOUT_API_MS = 30_000;
/** Timeout para ABRIR una descarga. Una vez que llegan las cabeceras se cancela: un
 *  escaneo del padron RUC tarda minutos y no puede morir por reloj a mitad del cuerpo. */
const TIMEOUT_DESCARGA_MS = 60_000;

const REINTENTOS = 3;
const BACKOFF_BASE_MS = 500;

export class HttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly url: string
  ) {
    super(message);
    this.name = "HttpError";
  }
}

function esReintentable(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

const dormir = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export interface OpcionesFetch {
  timeoutMs?: number;
  reintentos?: number;
  signal?: AbortSignal;
  headers?: Record<string, string>;
  /** Omite el timeout global de la respuesta (para cuerpos que se leen en streaming). */
  sinTimeoutPropio?: boolean;
}

/**
 * fetch con timeout, reintentos con backoff exponencial y User-Agent propio.
 * El portal responde HTML (no JSON) ante errores, asi que el status se valida aca
 * antes de que nadie intente parsear el cuerpo.
 */
export async function fetchConReintentos(url: string, opts: OpcionesFetch = {}): Promise<Response> {
  const timeoutMs = opts.timeoutMs ?? TIMEOUT_API_MS;
  const maxIntentos = opts.reintentos ?? REINTENTOS;
  let ultimoError: unknown;

  for (let intento = 1; intento <= maxIntentos; intento++) {
    const señales: AbortSignal[] = opts.sinTimeoutPropio ? [] : [AbortSignal.timeout(timeoutMs)];
    if (opts.signal) señales.push(opts.signal);

    try {
      const res = await fetch(url, {
        headers: { "user-agent": USER_AGENT, accept: "*/*", ...opts.headers },
        signal: señales.length ? AbortSignal.any(señales) : undefined,
        redirect: "follow",
      });

      if (res.ok) return res;

      // Cuerpo descartado: el portal devuelve paginas HTML de error que no aportan nada.
      await res.body?.cancel().catch(() => {});
      const err = new HttpError(`HTTP ${res.status} ${res.statusText}`.trim(), res.status, url);
      if (!esReintentable(res.status) || intento === maxIntentos) throw err;
      ultimoError = err;
    } catch (err) {
      // Un abort provocado por el llamador no se reintenta.
      if (opts.signal?.aborted) throw err;
      if (err instanceof HttpError && !esReintentable(err.status)) throw err;
      if (intento === maxIntentos) throw err;
      ultimoError = err;
    }

    await dormir(BACKOFF_BASE_MS * 2 ** (intento - 1));
  }

  throw ultimoError instanceof Error ? ultimoError : new Error(String(ultimoError));
}

export async function fetchJson<T>(url: string, opts: OpcionesFetch = {}): Promise<T> {
  const res = await fetchConReintentos(url, opts);
  const tipo = res.headers.get("content-type") ?? "";
  const texto = await res.text();

  if (!tipo.includes("json")) {
    const pista = texto.trim().startsWith("<")
      ? "el portal respondio HTML en vez de JSON (accion no soportada o portal caido)"
      : `content-type inesperado: ${tipo || "desconocido"}`;
    throw new Error(`Respuesta no-JSON de ${url}: ${pista}`);
  }

  try {
    return JSON.parse(texto) as T;
  } catch {
    throw new Error(`No se pudo parsear el JSON de ${url}`);
  }
}

/**
 * Abre una descarga larga. El timeout cubre solo la apertura: AbortSignal.timeout()
 * aborta la respuesta ENTERA, cuerpo incluido, asi que usarlo aca mataba los escaneos
 * largos a mitad de stream (y en silencio). El temporizador se limpia al recibir
 * cabeceras; a partir de ahi solo el llamador puede cancelar.
 */
export async function abrirDescarga(url: string, signal?: AbortSignal): Promise<Response> {
  const apertura = new AbortController();
  const temporizador = setTimeout(
    () => apertura.abort(new Error(`Timeout al abrir la descarga de ${url}`)),
    TIMEOUT_DESCARGA_MS
  );

  const señales = signal ? [apertura.signal, signal] : [apertura.signal];
  try {
    const res = await fetchConReintentos(url, {
      timeoutMs: TIMEOUT_DESCARGA_MS,
      signal: AbortSignal.any(señales),
      sinTimeoutPropio: true,
    });
    if (!res.body) throw new Error(`La respuesta de ${url} no trae cuerpo descargable`);
    return res;
  } finally {
    clearTimeout(temporizador);
  }
}
