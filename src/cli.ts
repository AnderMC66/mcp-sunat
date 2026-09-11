#!/usr/bin/env node
import { Command, InvalidArgumentError } from "commander";
import chalk from "chalk";
import Table from "cli-table3";
import ora, { type Ora } from "ora";
import figlet from "figlet";
import boxen from "boxen";
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
  type Operador,
} from "./core.js";
import { cacheDir, cacheStats, clearCache } from "./cache.js";

const AUTOR = "andermc66";
const VERSION = "2.0.0";

function espaciado(texto: string): string {
  return texto.toUpperCase().split("").join(" ");
}

function banner(): string {
  const nombre = chalk.cyan.bold(figlet.textSync("SUNAT MCP", { font: "Standard" }));
  const autor = chalk.magentaBright.bold.underline(`AUTOR: ${espaciado(AUTOR)}`);
  return boxen(`${nombre}\n${autor}`, {
    padding: 1,
    margin: 0,
    borderStyle: "round",
    borderColor: "cyan",
  });
}

function entero(nombre: string, min: number, max: number) {
  return (valor: string): number => {
    const n = Number(valor);
    if (!Number.isInteger(n) || n < min || n > max) {
      throw new InvalidArgumentError(`${nombre} debe ser un entero entre ${min} y ${max}.`);
    }
    return n;
  };
}

const OPERADORES: Operador[] = ["igual", "contiene", "empieza", "termina", "regex", "mayor", "menor"];

/** Parsea "columna=valor", "columna~valor" (contiene) o "columna:operador:valor". */
function parsearFiltro(expr: string, acumulado: Filtro[] = []): Filtro[] {
  const porOperador = expr.match(/^([^:]+):([a-z]+):(.*)$/i);
  if (porOperador && OPERADORES.includes(porOperador[2].toLowerCase() as Operador)) {
    acumulado.push({
      columna: porOperador[1],
      operador: porOperador[2].toLowerCase() as Operador,
      valor: porOperador[3],
    });
    return acumulado;
  }

  const contiene = expr.match(/^([^~]+)~(.*)$/);
  if (contiene) {
    acumulado.push({ columna: contiene[1], operador: "contiene", valor: contiene[2] });
    return acumulado;
  }

  const igual = expr.match(/^([^=]+)=(.*)$/);
  if (igual) {
    acumulado.push({ columna: igual[1], operador: "igual", valor: igual[2] });
    return acumulado;
  }

  throw new InvalidArgumentError(
    `Filtro invalido: '${expr}'. Formatos validos: columna=valor, columna~valor (contiene), ` +
      `columna:operador:valor (operadores: ${OPERADORES.join(", ")}).`
  );
}

const program = new Command();

program
  .name("sunat")
  .version(VERSION)
  .description("CLI para explorar, consultar y descargar los datasets abiertos de SUNAT (datosabiertos.gob.pe)")
  .option("--json", "imprime JSON crudo en vez de tablas formateadas")
  .option("--no-color", "desactiva colores en la salida")
  .addHelpText("beforeAll", () => (process.env.NO_COLOR ? "" : banner()))
  .hook("preAction", () => {
    // El flag se aplica aca: declararlo no basta, chalk decide su nivel al importarse.
    if (program.opts().color === false || jsonMode()) chalk.level = 0;
  });

if (process.argv.length <= 2) {
  process.argv.push("--help");
}

function jsonMode(): boolean {
  return Boolean(program.opts().json);
}

function imprimir(data: unknown, tabla: () => void) {
  if (jsonMode()) {
    console.log(JSON.stringify(data, null, 2));
  } else {
    tabla();
  }
}

async function conSpinner<T>(texto: string, fn: () => Promise<T>): Promise<T> {
  if (jsonMode()) return fn();
  const spinner = ora(texto).start();
  try {
    const result = await fn();
    spinner.stop();
    return result;
  } catch (err) {
    spinner.fail(texto.replace(/\.\.\.$/, " fallo"));
    throw err;
  }
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i++;
  }
  return `${value.toFixed(1)} ${units[i]}`;
}

function recortar(texto: string, max: number): string {
  return texto.length > max ? `${texto.slice(0, max - 1)}…` : texto;
}

/**
 * Los csv de SUNAT tienen 16+ columnas y una tabla con todas desborda cualquier
 * terminal, asi que se muestran solo las que entran y se avisa cuantas quedaron fuera.
 */
function tablaDeFilas(columnas: string[], filas: Record<string, string>[]): void {
  if (filas.length === 0) {
    console.log(chalk.yellow("Sin resultados."));
    return;
  }
  const ancho = process.stdout.columns || 120;
  const maxCols = Math.max(2, Math.floor(ancho / 22));
  const visibles = columnas.slice(0, maxCols);

  const t = new Table({ head: visibles.map((c) => chalk.bold(recortar(c, 20))), wordWrap: false });
  for (const fila of filas) t.push(visibles.map((c) => recortar(fila[c] ?? "", 20)));
  console.log(t.toString());

  if (columnas.length > visibles.length) {
    console.log(
      chalk.dim(
        `(${columnas.length - visibles.length} columnas ocultas por ancho de terminal: ` +
          `${columnas.slice(maxCols).join(", ")}. Usa --json para verlas todas.)`
      )
    );
  }
}

// ------------------------------------------------------------ catalogo

program
  .command("list")
  .description("Lista los datasets de SUNAT disponibles")
  .action(async () => {
    const datasets = await conSpinner("Consultando datasets de SUNAT...", listarDatasets);
    imprimir(datasets, () => {
      const t = new Table({
        head: [chalk.bold("dataset"), chalk.bold("titulo"), chalk.bold("recursos")],
      });
      for (const d of datasets) t.push([recortar(d.dataset, 50), recortar(d.titulo, 60), String(d.cantidad_recursos)]);
      console.log(t.toString());
    });
  });

program
  .command("search <consulta...>")
  .description("Busca recursos por palabras clave en todo el catalogo (ej: sunat search padron ruc 2024-03)")
  .option("-n, --limit <numero>", "maximo de resultados", entero("--limit", 1, 100), 25)
  .action(async (consulta: string[], opts: { limit: number }) => {
    const texto = consulta.join(" ");
    const resultados = await conSpinner(`Buscando '${texto}'...`, () => buscarRecursos(texto, opts.limit));
    imprimir(resultados, () => {
      if (resultados.length === 0) {
        console.log(chalk.yellow(`Sin coincidencias para '${texto}'.`));
        return;
      }
      const t = new Table({
        head: [chalk.bold("id"), chalk.bold("nombre"), chalk.bold("formato"), chalk.bold("tamano")],
      });
      for (const r of resultados) t.push([r.id, recortar(r.nombre, 45), r.formato, r.tamano ?? "-"]);
      console.log(t.toString());
    });
  });

program
  .command("show <dataset>")
  .description("Muestra el detalle y los recursos de un dataset (slug obtenido de 'list')")
  .action(async (dataset: string) => {
    const detalle = await conSpinner(`Consultando dataset ${dataset}...`, () => obtenerDataset(dataset));
    imprimir(detalle, () => {
      console.log(chalk.bold(detalle.titulo));
      if (detalle.descripcion) console.log(chalk.dim(recortar(detalle.descripcion, 400)));
      console.log();
      const t = new Table({
        head: [chalk.bold("id"), chalk.bold("nombre"), chalk.bold("formato"), chalk.bold("tamano")],
      });
      for (const r of detalle.recursos) t.push([r.id, recortar(r.nombre, 45), r.formato, r.tamano ?? "-"]);
      console.log(t.toString());
    });
  });

program
  .command("latest <dataset>")
  .description("Muestra el recurso con el periodo mas reciente de un dataset")
  .action(async (dataset: string) => {
    const r = await conSpinner(`Buscando el ultimo recurso de ${dataset}...`, () => recursoMasReciente(dataset));
    imprimir(r, () => {
      const t = new Table();
      t.push(
        [chalk.bold("id"), r.id],
        [chalk.bold("nombre"), r.nombre],
        [chalk.bold("formato"), r.formato],
        [chalk.bold("tamano"), r.tamano ?? "-"]
      );
      console.log(t.toString());
    });
  });

program
  .command("resource <resource_id>")
  .description("Muestra metadata y URL de descarga de un recurso")
  .action(async (resourceId: string) => {
    const info = await conSpinner(`Consultando recurso ${resourceId}...`, () => obtenerRecurso(resourceId));
    imprimir(info, () => {
      const t = new Table();
      t.push(
        [chalk.bold("nombre"), info.nombre],
        [chalk.bold("url"), info.url_descarga],
        [chalk.bold("formato real"), info.formato_real],
        [chalk.bold("formato declarado"), info.formato_declarado],
        [chalk.bold("es zip"), info.es_zip ? "si" : "no"],
        [chalk.bold("tamano"), info.tamano ?? "-"],
        [chalk.bold("ultima modificacion"), info.ultima_modificacion ?? "-"]
      );
      console.log(t.toString());
    });
  });

// ------------------------------------------------------------ datos

program
  .command("schema <resource_id>")
  .description("Perfila las columnas reales del archivo (tipos, vacios, ejemplos) sin descargarlo")
  .option("-n, --rows <numero>", "filas de muestra a analizar", entero("--rows", 10, 100000), 5000)
  .option("-f, --file <nombre>", "archivo dentro del zip, si hay varios")
  .action(async (resourceId: string, opts: { rows: number; file?: string }) => {
    const perfil = await conSpinner(`Perfilando ${resourceId}...`, () =>
      perfilarRecurso(resourceId, opts.rows, opts.file)
    );
    imprimir(perfil, () => {
      console.log(chalk.bold(perfil.recurso));
      console.log(
        chalk.dim(
          `archivo: ${perfil.archivo ?? "-"} | delimitador: ${JSON.stringify(perfil.delimitador)} | ` +
            `encoding: ${perfil.encoding} | filas analizadas: ${perfil.filas_analizadas}`
        )
      );
      console.log();
      const t = new Table({
        head: ["columna", "tipo", "vacios", "distintos", "ejemplo"].map((h) => chalk.bold(h)),
      });
      for (const c of perfil.columnas) {
        t.push([
          recortar(c.columna, 38),
          c.tipo_inferido,
          String(c.vacios),
          String(c.valores_distintos),
          recortar(c.ejemplos[0] ?? "-", 30),
        ]);
      }
      console.log(t.toString());
      console.log(chalk.dim(perfil.nota));
    });
  });

program
  .command("preview <resource_id>")
  .description("Previsualiza las primeras filas de un recurso (csv suelto o dentro de zip)")
  .option("-n, --rows <numero>", "cantidad de filas a mostrar", entero("--rows", 1, 500), 20)
  .option("-f, --file <nombre>", "archivo dentro del zip, si hay varios")
  .action(async (resourceId: string, opts: { rows: number; file?: string }) => {
    const prev = await conSpinner(`Previsualizando ${resourceId}...`, () =>
      previsualizarRecurso(resourceId, opts.rows, opts.file)
    );
    imprimir(prev, () => {
      console.log(
        chalk.dim(
          `${prev.archivo ?? prev.recurso} | delimitador: ${JSON.stringify(prev.delimitador)} | ` +
            `encoding: ${prev.encoding}`
        )
      );
      tablaDeFilas(prev.columnas, prev.filas);
      console.log(chalk.dim(prev.nota));
    });
  });

program
  .command("find <resource_id>")
  .description("Busca filas dentro de un recurso en streaming, sin descargarlo")
  .option(
    "-w, --where <filtro>",
    "filtro columna=valor, columna~valor (contiene) o columna:operador:valor (repetible)",
    parsearFiltro,
    [] as Filtro[]
  )
  .option("-t, --text <texto>", "texto libre buscado en la fila completa (rapido)")
  .option("-c, --cols <columnas>", "columnas a devolver, separadas por coma", (v: string) =>
    v.split(",").map((s) => s.trim()).filter(Boolean)
  )
  .option("-n, --limit <numero>", "maximo de filas a devolver", entero("--limit", 1, 1000), 50)
  .option("--max-rows <numero>", "tope de filas a escanear", entero("--max-rows", 1000, 5000000))
  .option("-f, --file <nombre>", "archivo dentro del zip, si hay varios")
  .action(
    async (
      resourceId: string,
      opts: { where: Filtro[]; text?: string; cols?: string[]; limit: number; maxRows?: number; file?: string }
    ) => {
      const res = await conSpinner(`Escaneando ${resourceId}...`, () =>
        buscarEnRecurso(resourceId, {
          filtros: opts.where,
          texto: opts.text,
          columnas: opts.cols,
          limite: opts.limit,
          maxFilas: opts.maxRows,
          archivo: opts.file,
        })
      );
      imprimir(res, () => {
        tablaDeFilas(res.columnas, res.filas);
        console.log(
          chalk.dim(
            `${res.coincidencias} coincidencia(s) | ${res.filas_escaneadas.toLocaleString("es-PE")} filas escaneadas | ` +
              `${formatBytes(res.bytes_leidos)} leidos | escaneo completo: ${res.escaneo_completo ? "si" : "no"}`
          )
        );
        console.log(chalk.dim(res.nota));
      });
    }
  );

program
  .command("count <resource_id> <columna>")
  .description("Cuenta filas agrupadas por el valor de una columna, en streaming")
  .option("-w, --where <filtro>", "filtro previo (mismo formato que 'find', repetible)", parsearFiltro, [] as Filtro[])
  .option("-n, --top <numero>", "cuantos valores mostrar", entero("--top", 1, 1000), 50)
  .option("--max-rows <numero>", "tope de filas a escanear", entero("--max-rows", 1000, 5000000))
  .option("-f, --file <nombre>", "archivo dentro del zip, si hay varios")
  .action(
    async (
      resourceId: string,
      columna: string,
      opts: { where: Filtro[]; top: number; maxRows?: number; file?: string }
    ) => {
      const res = await conSpinner(`Contando por '${columna}'...`, () =>
        contarPorColumna(resourceId, columna, {
          filtros: opts.where,
          top: opts.top,
          maxFilas: opts.maxRows,
          archivo: opts.file,
        })
      );
      imprimir(res, () => {
        const total = res.valores.reduce((a, v) => a + v.filas, 0) || 1;
        const t = new Table({ head: [chalk.bold(res.columna), chalk.bold("filas"), chalk.bold("%")] });
        for (const v of res.valores) {
          t.push([recortar(v.valor, 45), v.filas.toLocaleString("es-PE"), `${((v.filas / total) * 100).toFixed(1)}%`]);
        }
        console.log(t.toString());
        console.log(
          chalk.dim(
            `${res.valores_distintos} valores distintos | ${res.filas_escaneadas.toLocaleString("es-PE")} filas ` +
              `escaneadas | escaneo completo: ${res.escaneo_completo ? "si" : "no"}`
          )
        );
      });
    }
  );

// ------------------------------------------------------------ descarga

program
  .command("download <resource_id>")
  .description("Descarga el recurso completo (csv o zip) a disco")
  .option("-o, --out <ruta>", "ruta de archivo destino")
  .action(async (resourceId: string, opts: { out?: string }) => {
    const destino = opts.out
      ? path.resolve(opts.out)
      : path.join(process.env.SUNAT_DOWNLOAD_DIR || path.join(os.tmpdir(), "sunat-cli"), resourceId);

    if (jsonMode()) {
      console.log(JSON.stringify(await descargarRecurso(resourceId, destino), null, 2));
      return;
    }

    const spinner: Ora = ora(`Descargando ${resourceId}...`).start();
    try {
      const resultado = await descargarRecurso(resourceId, destino, (bytes, total) => {
        spinner.text = total
          ? `Descargando ${resourceId}... ${formatBytes(bytes)} / ${formatBytes(total)} (${((bytes / total) * 100).toFixed(1)}%)`
          : `Descargando ${resourceId}... ${formatBytes(bytes)}`;
      });
      spinner.succeed(`Descargado en ${resultado.path} (${formatBytes(resultado.bytes)})`);
    } catch (err) {
      spinner.fail(`Fallo la descarga de ${resourceId}`);
      throw err;
    }
  });

// ------------------------------------------------------------ cache

const cache = program.command("cache").description("Administra la cache local del catalogo");

cache
  .command("clear")
  .description("Elimina la cache local")
  .action(async () => {
    await clearCache();
    console.log(chalk.green(`Cache limpiada (${cacheDir()})`));
  });

cache
  .command("status")
  .description("Muestra ubicacion, tamano y antiguedad de la cache")
  .action(async () => {
    const stats = await cacheStats();
    imprimir(stats, () => {
      const t = new Table();
      t.push(
        [chalk.bold("directorio"), stats.directorio],
        [chalk.bold("entradas"), String(stats.entradas)],
        [chalk.bold("tamano"), formatBytes(stats.bytes)],
        [chalk.bold("ttl"), `${(stats.ttl_ms / 3600000).toFixed(1)} h`],
        [chalk.bold("mas antigua"), stats.mas_antigua ?? "-"]
      );
      console.log(t.toString());
    });
  });

cache
  .command("path")
  .description("Muestra la ubicacion de la cache local")
  .action(() => {
    console.log(cacheDir());
  });

program.parseAsync(process.argv).catch((err) => {
  console.error(chalk.red(`Error: ${err instanceof Error ? err.message : String(err)}`));
  process.exitCode = 1;
});
