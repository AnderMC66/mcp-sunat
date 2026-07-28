#!/usr/bin/env node
import { Command } from "commander";
import chalk from "chalk";
import Table from "cli-table3";
import ora from "ora";
import figlet from "figlet";
import boxen from "boxen";
import os from "node:os";
import path from "node:path";
import {
  listarDatasets,
  obtenerDataset,
  obtenerRecurso,
  previsualizarRecurso,
  descargarRecurso,
} from "./core.js";
import { cacheDir, clearCache } from "./cache.js";

const AUTOR = "andermc66";

function espaciado(texto: string): string {
  return texto.toUpperCase().split("").join(" ");
}

function banner(): string {
  const nombre = chalk.cyan.bold(figlet.textSync("SUNAT MCP", { font: "Standard" }));
  const autor = chalk.magentaBright.bold.underline(`AUTOR: ${espaciado(AUTOR)}`);
  const info = boxen(`${nombre}\n${autor}`, {
    padding: 1,
    margin: 0,
    borderStyle: "round",
    borderColor: "cyan",
  });
  return info;
}

const program = new Command();

program
  .name("sunat")
  .description("CLI para explorar y descargar los datasets abiertos de SUNAT (datosabiertos.gob.pe)")
  .option("--json", "imprime JSON crudo en vez de tablas formateadas")
  .option("--no-color", "desactiva colores en la salida")
  .addHelpText("beforeAll", () => banner());

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
    spinner.stop();
    throw err;
  }
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i++;
  }
  return `${value.toFixed(1)} ${units[i]}`;
}

program
  .command("list")
  .description("Lista los datasets de SUNAT disponibles")
  .action(async () => {
    const datasets = await conSpinner("Consultando datasets de SUNAT...", listarDatasets);
    imprimir(datasets, () => {
      const t = new Table({ head: [chalk.bold("dataset"), chalk.bold("titulo"), chalk.bold("recursos")] });
      for (const d of datasets) t.push([d.dataset, d.titulo, String(d.cantidad_recursos)]);
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
      if (detalle.descripcion) console.log(chalk.dim(detalle.descripcion));
      console.log();
      const t = new Table({ head: [chalk.bold("id"), chalk.bold("nombre"), chalk.bold("formato"), chalk.bold("tamano")] });
      for (const r of detalle.recursos) t.push([r.id, r.nombre, r.formato, r.tamano ?? "-"]);
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
        [chalk.bold("formato declarado"), info.formato_declarado],
        [chalk.bold("es zip"), info.es_zip ? "si" : "no"],
        [chalk.bold("tamano"), info.tamano ?? "-"],
        [chalk.bold("ultima modificacion"), info.ultima_modificacion ?? "-"]
      );
      console.log(t.toString());
    });
  });

program
  .command("preview <resource_id>")
  .description("Previsualiza las primeras filas de un recurso (csv suelto o dentro de zip)")
  .option("-n, --rows <numero>", "cantidad de filas a mostrar", "20")
  .action(async (resourceId: string, opts: { rows: string }) => {
    const filas = Number(opts.rows);
    const previsualizacion = await conSpinner(`Previsualizando ${resourceId}...`, () =>
      previsualizarRecurso(resourceId, filas)
    );
    imprimir(previsualizacion, () => {
      const t = new Table({ head: previsualizacion.encabezado.map((h) => chalk.bold(h)) });
      for (const fila of previsualizacion.filas) t.push(splitRow(fila));
      console.log(t.toString());
      console.log(chalk.dim(previsualizacion.nota));
    });
  });

function splitRow(line: string): string[] {
  return line.includes(";") ? line.split(";") : line.split(",");
}

program
  .command("download <resource_id>")
  .description("Descarga el recurso completo (csv o zip) a disco")
  .option("-o, --out <ruta>", "ruta de archivo destino")
  .action(async (resourceId: string, opts: { out?: string }) => {
    const destino = opts.out || path.join(os.tmpdir(), "sunat-cli", resourceId);
    if (jsonMode()) {
      const resultado = await descargarRecurso(resourceId, destino);
      console.log(JSON.stringify(resultado, null, 2));
      return;
    }
    const spinner = ora(`Descargando ${resourceId}...`).start();
    const resultado = await descargarRecurso(resourceId, destino, (bytes, total) => {
      if (total) {
        const pct = ((bytes / total) * 100).toFixed(1);
        spinner.text = `Descargando ${resourceId}... ${formatBytes(bytes)} / ${formatBytes(total)} (${pct}%)`;
      } else {
        spinner.text = `Descargando ${resourceId}... ${formatBytes(bytes)}`;
      }
    });
    spinner.succeed(`Descargado en ${resultado.path} (${formatBytes(resultado.bytes)})`);
  });

const cache = program.command("cache").description("Administra la cache local de datasets");

cache
  .command("clear")
  .description("Elimina la cache local de datasets")
  .action(async () => {
    await clearCache();
    console.log(chalk.green(`Cache limpiada (${cacheDir()})`));
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
