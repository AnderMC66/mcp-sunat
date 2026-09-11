#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import os from "node:os";
import path from "node:path";
import {
  listarDatasets,
  obtenerDataset,
  buscarRecursos,
  recursoMasReciente,
  obtenerRecurso,
  previsualizarRecurso,
  buscarEnRecurso,
  contarPorColumna,
  perfilarRecurso,
  descargarRecurso,
  type Filtro,
} from "./core.js";
import { cacheStats, clearCache } from "./cache.js";

const VERSION = "2.0.0";

const server = new McpServer({
  name: "sunat-datos-abiertos-mcp",
  version: VERSION,
});

type Contenido = { content: { type: "text"; text: string }[]; structuredContent?: Record<string, unknown>; isError?: boolean };

/**
 * Devuelve el resultado como texto JSON (para el modelo) y como structuredContent
 * (para clientes que lo consuman programaticamente). Un throw dentro del handler
 * se convertiria en un error de protocolo sin contexto util, asi que los errores
 * se devuelven como isError con el mensaje real y una pista de que hacer.
 */
async function responder(
  fn: () => Promise<unknown>,
  pista?: string
): Promise<Contenido> {
  try {
    const data = await fn();
    const texto = JSON.stringify(data, null, 2);
    const structured =
      data !== null && typeof data === "object" && !Array.isArray(data)
        ? (data as Record<string, unknown>)
        : { resultado: data };
    return { content: [{ type: "text", text: texto }], structuredContent: structured };
  } catch (err) {
    const mensaje = err instanceof Error ? err.message : String(err);
    return {
      content: [{ type: "text", text: pista ? `${mensaje}\n\nSugerencia: ${pista}` : mensaje }],
      isError: true,
    };
  }
}

const filtroSchema = z.object({
  columna: z.string().describe("Nombre de la columna tal como aparece en el encabezado (sin distinguir tildes ni mayusculas)"),
  operador: z
    .enum(["igual", "contiene", "empieza", "termina", "regex", "mayor", "menor"])
    .describe("Comparacion a aplicar. 'mayor'/'menor' requieren que el valor sea numerico"),
  valor: z.string().describe("Valor a comparar"),
});

// ------------------------------------------------------------ catalogo

server.registerTool(
  "sunat_listar_datasets",
  {
    title: "Listar datasets de SUNAT",
    description:
      "Lista los datasets publicados por SUNAT en la Plataforma Nacional de Datos Abiertos del Peru " +
      "(padron RUC, padron de emisores electronicos, agentes de retencion/percepcion de IGV, etc.). " +
      "Son pocos datasets pero con muchos recursos mensuales cada uno: si ya sabes que archivo buscas, " +
      "'sunat_buscar_recursos' es mas directo que listar y luego abrir el dataset.",
    inputSchema: {},
  },
  async () => responder(listarDatasets)
);

server.registerTool(
  "sunat_obtener_dataset",
  {
    title: "Obtener detalle de un dataset de SUNAT",
    description:
      "Devuelve la descripcion y la lista completa de recursos (archivos) de un dataset, identificado por " +
      "su slug (campo 'dataset' de 'sunat_listar_datasets'). Cada recurso trae un 'id' que se usa con las " +
      "demas tools. Ojo: el padron RUC tiene decenas de recursos (uno por mes).",
    inputSchema: {
      dataset: z.string().describe("Slug del dataset, obtenido de sunat_listar_datasets"),
    },
  },
  async ({ dataset }) =>
    responder(
      () => obtenerDataset(dataset),
      "Verifica el slug con sunat_listar_datasets; el slug lleva tildes y enies."
    )
);

server.registerTool(
  "sunat_buscar_recursos",
  {
    title: "Buscar archivos de SUNAT por palabras clave",
    description:
      "Busca recursos (archivos) en todo el catalogo de SUNAT por palabras clave, sin distinguir tildes ni " +
      "mayusculas. Busca en el nombre del archivo, su descripcion y el titulo del dataset; todos los terminos " +
      "deben coincidir. Ejemplos de consulta: 'padron ruc 2024-03', 'agentes retencion', 'comprobantes 2023'. " +
      "Es la forma mas rapida de llegar al 'id' de un recurso concreto.",
    inputSchema: {
      consulta: z.string().min(1).describe("Palabras clave, por ejemplo 'padron ruc 2024-03'"),
      limite: z.number().int().min(1).max(100).default(25).describe("Maximo de resultados"),
    },
  },
  async ({ consulta, limite }) =>
    responder(
      () => buscarRecursos(consulta, limite),
      "Prueba con menos palabras o usa sunat_listar_datasets para ver que hay publicado."
    )
);

server.registerTool(
  "sunat_recurso_mas_reciente",
  {
    title: "Obtener el recurso mas reciente de un dataset",
    description:
      "Devuelve el recurso con el periodo mas reciente de un dataset (por ejemplo, el ultimo padron RUC " +
      "mensual publicado). Evita tener que listar decenas de recursos para quedarse con el ultimo.",
    inputSchema: {
      dataset: z.string().describe("Slug del dataset, obtenido de sunat_listar_datasets"),
    },
  },
  async ({ dataset }) =>
    responder(() => recursoMasReciente(dataset), "Verifica el slug con sunat_listar_datasets.")
);

server.registerTool(
  "sunat_obtener_recurso",
  {
    title: "Obtener metadata y URL de descarga de un recurso",
    description:
      "Dado el 'id' de un recurso, devuelve su metadata completa incluyendo la URL directa de descarga. " +
      "Incluye 'formato_real', que se calcula de la URL y el mimetype porque el 'formato_declarado' de este " +
      "portal no es confiable: muchos archivos declarados csv son en realidad .zip con el csv adentro.",
    inputSchema: {
      resource_id: z.string().describe("Id del recurso"),
    },
  },
  async ({ resource_id }) =>
    responder(() => obtenerRecurso(resource_id), "Obten el id con sunat_buscar_recursos o sunat_obtener_dataset.")
);

// ------------------------------------------------------------ datos

server.registerTool(
  "sunat_perfilar_recurso",
  {
    title: "Perfilar el esquema y los valores de un recurso",
    description:
      "Analiza una muestra del archivo y devuelve sus columnas reales con tipo inferido, cantidad de vacios, " +
      "valores distintos y ejemplos. USALO ANTES de 'sunat_buscar_en_recurso' o 'sunat_contar_por_columna' " +
      "para saber que columnas existen y que valores admiten. No descarga el archivo completo.",
    inputSchema: {
      resource_id: z.string().describe("Id del recurso a perfilar"),
      filas: z.number().int().min(10).max(100000).default(5000).describe("Filas de muestra a analizar"),
      archivo: z
        .string()
        .optional()
        .describe("Si el zip trae varios archivos, nombre (o parte del nombre) del que se quiere analizar"),
    },
  },
  async ({ resource_id, filas, archivo }) =>
    responder(() => perfilarRecurso(resource_id, filas, archivo))
);

server.registerTool(
  "sunat_previsualizar_recurso",
  {
    title: "Previsualizar las primeras filas de un recurso",
    description:
      "Lee solo el inicio del archivo (csv suelto o csv dentro de un zip) y devuelve el encabezado mas las " +
      "primeras filas ya parseadas como objetos, detectando automaticamente el delimitador (| ; , tab) y el " +
      "encoding (utf-8 o latin1). No descarga el archivo completo: algunos pesan varios GB.",
    inputSchema: {
      resource_id: z.string().describe("Id del recurso a previsualizar"),
      filas: z.number().int().min(1).max(500).default(20).describe("Cantidad de filas de datos a devolver"),
      archivo: z
        .string()
        .optional()
        .describe("Si el zip trae varios archivos, nombre (o parte del nombre) del que se quiere leer"),
    },
  },
  async ({ resource_id, filas, archivo }) =>
    responder(() => previsualizarRecurso(resource_id, filas, archivo))
);

server.registerTool(
  "sunat_buscar_en_recurso",
  {
    title: "Buscar filas dentro de un recurso sin descargarlo",
    description:
      "Filtra filas dentro del archivo de un recurso leyendolo en streaming, sin guardarlo en disco ni cargarlo " +
      "en memoria: sirve para consultar padrones de varios GB. Acepta filtros por columna y/o un texto libre que " +
      "se busca en la fila completa (ignora tildes y mayusculas). Corta apenas junta 'limite' coincidencias. " +
      "Ejemplo: filtros=[{columna:'RUC', operador:'igual', valor:'20100070970'}] sobre un padron RUC. " +
      "El campo 'escaneo_completo' dice si el conteo de coincidencias es exacto o si se corto antes del final.",
    inputSchema: {
      resource_id: z.string().describe("Id del recurso donde buscar"),
      filtros: z.array(filtroSchema).optional().describe("Condiciones por columna; se combinan con AND"),
      texto: z
        .string()
        .optional()
        .describe("Texto libre buscado en la fila completa. Mucho mas rapido que un filtro por columna"),
      columnas: z
        .array(z.string())
        .optional()
        .describe("Columnas a devolver. Si se omite, se devuelven todas (puede ser mucho texto)"),
      limite: z.number().int().min(1).max(1000).default(50).describe("Maximo de filas a devolver"),
      max_filas: z
        .number()
        .int()
        .min(1000)
        .max(5000000)
        .optional()
        .describe("Tope de filas a escanear antes de rendirse. Bajalo para respuestas mas rapidas"),
      archivo: z
        .string()
        .optional()
        .describe("Si el zip trae varios archivos, nombre (o parte del nombre) del que se quiere leer"),
    },
  },
  async ({ resource_id, filtros, texto, columnas, limite, max_filas, archivo }) =>
    responder(
      () =>
        buscarEnRecurso(resource_id, {
          filtros: filtros as Filtro[] | undefined,
          texto,
          columnas,
          limite,
          maxFilas: max_filas,
          archivo,
        }),
      "Usa sunat_perfilar_recurso para ver los nombres exactos de las columnas."
    )
);

server.registerTool(
  "sunat_contar_por_columna",
  {
    title: "Contar filas agrupadas por el valor de una columna",
    description:
      "Agrupa y cuenta filas por el valor de una columna (group by) leyendo el archivo en streaming. Responde " +
      "preguntas agregadas como 'cuantos contribuyentes hay por departamento' o 'cuantos estan ACTIVOS', sin " +
      "descargar el archivo. Admite filtros previos. No uses columnas de alta cardinalidad como RUC: para eso " +
      "esta 'sunat_buscar_en_recurso'.",
    inputSchema: {
      resource_id: z.string().describe("Id del recurso"),
      columna: z.string().describe("Columna por la que agrupar, por ejemplo 'Departamento' o 'Estado'"),
      filtros: z.array(filtroSchema).optional().describe("Condiciones previas por columna; se combinan con AND"),
      top: z.number().int().min(1).max(1000).default(50).describe("Cuantos valores devolver, ordenados por frecuencia"),
      max_filas: z
        .number()
        .int()
        .min(1000)
        .max(5000000)
        .optional()
        .describe("Tope de filas a escanear. Bajalo para una estimacion rapida sobre una muestra"),
      archivo: z.string().optional().describe("Nombre (o parte) del archivo dentro del zip, si hay varios"),
    },
  },
  async ({ resource_id, columna, filtros, top, max_filas, archivo }) =>
    responder(
      () =>
        contarPorColumna(resource_id, columna, {
          filtros: filtros as Filtro[] | undefined,
          top,
          maxFilas: max_filas,
          archivo,
        }),
      "Usa sunat_perfilar_recurso para ver los nombres exactos de las columnas y su cardinalidad."
    )
);

// ------------------------------------------------------------ descarga

function carpetaDescargas(): string {
  return process.env.SUNAT_DOWNLOAD_DIR || path.join(os.tmpdir(), "sunat-mcp");
}

server.registerTool(
  "sunat_descargar_recurso",
  {
    title: "Descargar un recurso completo a disco",
    description:
      "Descarga el archivo completo (csv o zip) al disco local y devuelve la ruta y el tamano. No devuelve el " +
      "contenido, solo donde quedo guardado. Antes de usar esta tool considera 'sunat_buscar_en_recurso' o " +
      "'sunat_contar_por_columna': responden sobre el archivo completo sin bajar cientos de MB ni llenar el disco.",
    inputSchema: {
      resource_id: z.string().describe("Id del recurso a descargar"),
      destino: z
        .string()
        .optional()
        .describe(
          "Ruta de archivo destino. Si se omite, se guarda en SUNAT_DOWNLOAD_DIR (o el temp del sistema) " +
            "usando el nombre del recurso. Si la ruta no trae extension, se le agrega la real (.zip/.csv)."
        ),
    },
  },
  async ({ resource_id, destino }) =>
    responder(() => {
      const ruta = destino ? path.resolve(destino) : path.join(carpetaDescargas(), resource_id);
      return descargarRecurso(resource_id, ruta);
    }, "Revisa que la carpeta destino exista y tengas permiso de escritura.")
);

// ------------------------------------------------------------ cache

server.registerTool(
  "sunat_cache",
  {
    title: "Inspeccionar o limpiar la cache local del catalogo",
    description:
      "El catalogo de SUNAT (datasets, recursos y su metadata) se cachea en disco porque cambia poco. " +
      "Con accion='estado' devuelve donde esta y cuanto ocupa; con accion='limpiar' la borra para forzar una " +
      "consulta fresca al portal. Los datos de los archivos nunca se cachean, solo la metadata.",
    inputSchema: {
      accion: z.enum(["estado", "limpiar"]).default("estado").describe("Que hacer con la cache"),
    },
  },
  async ({ accion }) =>
    responder(async () => {
      if (accion === "limpiar") {
        await clearCache();
        return { ...(await cacheStats()), mensaje: "Cache limpiada." };
      }
      return cacheStats();
    })
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`sunat-datos-abiertos-mcp v${VERSION} corriendo por stdio`);
}

main().catch((err) => {
  console.error("Error fatal:", err);
  process.exit(1);
});
