import test from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import {
  detectarDelimitador,
  splitCsvLine,
  detectarEncoding,
  iterarLineas,
  nuevoEstado,
  normalizar,
  filaAObjeto,
} from "./csv.js";

test("detecta el delimitador real de cada padron", () => {
  // PadronRUC_202209.csv usa "|", PadronRUC_202412.csv usa ",": ambos existen.
  assert.equal(detectarDelimitador("RUC|Estado|Condicion|Tipo"), "|");
  assert.equal(detectarDelimitador("RUC,Estado,Condicion,Tipo"), ",");
  assert.equal(detectarDelimitador("a;b;c"), ";");
  assert.equal(detectarDelimitador("a\tb\tc"), "\t");
});

test("no confunde comas dentro de campos entrecomillados con el delimitador", () => {
  assert.equal(detectarDelimitador('RUC|"APELLIDO, NOMBRE"|Estado'), "|");
});

test("splitCsvLine respeta comillas y comillas escapadas", () => {
  assert.deepEqual(splitCsvLine("a,b,c", ","), ["a", "b", "c"]);
  assert.deepEqual(splitCsvLine('a,"b,c",d', ","), ["a", "b,c", "d"]);
  assert.deepEqual(splitCsvLine('a,"b""c",d', ","), ["a", 'b"c', "d"]);
  assert.deepEqual(splitCsvLine("a,,c", ","), ["a", "", "c"]);
});

test("detecta latin1 cuando utf-8 no decodifica", () => {
  assert.equal(detectarEncoding(Buffer.from("HUANUCO\n", "utf-8")), "utf-8");
  assert.equal(detectarEncoding(Buffer.from("ENSEÑANZA\n", "utf-8")), "utf-8");
  // El padron RUC viene en latin1: Ñ es el byte 0xD1 suelto, invalido en utf-8.
  assert.equal(detectarEncoding(Buffer.from("ENSEÑANZA\n", "latin1")), "latin1");
});

test("no toma por latin1 un utf-8 cortado a mitad de caracter", () => {
  const completo = Buffer.from("HUÁNUCO\nLIMA\n", "utf-8");
  // Se corta dejando un caracter multibyte incompleto al final del muestreo.
  assert.equal(detectarEncoding(completo.subarray(0, completo.length - 3)), "utf-8");
});

async function lineasDe(chunks: (string | Buffer)[], opts = {}) {
  const stream = Readable.from(chunks.map((c) => (Buffer.isBuffer(c) ? c : Buffer.from(c, "latin1"))));
  const out: string[] = [];
  for await (const l of iterarLineas(stream, opts)) out.push(l);
  return out;
}

test("reconstruye lineas partidas entre chunks", async () => {
  assert.deepEqual(await lineasDe(["RUC,Est", "ado\n1,ACT", "IVO\n2,BAJA\n"]), [
    "RUC,Estado",
    "1,ACTIVO",
    "2,BAJA",
  ]);
});

test("quita el retorno de carro de archivos con CRLF", async () => {
  assert.deepEqual(await lineasDe(["a,b\r\nc,d\r\n"]), ["a,b", "c,d"]);
});

test("emite la ultima linea aunque no termine en salto", async () => {
  assert.deepEqual(await lineasDe(["a,b\nc,d"]), ["a,b", "c,d"]);
});

test("no emite una linea parcial cuando corta por limite de bytes", async () => {
  const estado = nuevoEstado();
  const lineas = await lineasDe(["aaaa\nbbbb\ncccc"], { maxBytes: 12, estado });
  assert.equal(estado.truncado, true);
  // "cccc" quedo a medias: se descarta en vez de devolverse como fila valida.
  assert.deepEqual(lineas, ["aaaa", "bbbb"]);
});

test("decodifica latin1 sin mojibake y reporta el encoding detectado", async () => {
  const estado = nuevoEstado();
  const lineas = await lineasDe([Buffer.from("Departamento\nHUÁNUCO\n", "latin1")], { estado });
  assert.deepEqual(lineas, ["Departamento", "HUÁNUCO"]);
  assert.equal(estado.encoding, "latin1");
});

test("descarta el BOM del utf-8", async () => {
  const conBom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("RUC,Estado\n", "utf-8")]);
  assert.deepEqual(await lineasDe([conBom]), ["RUC,Estado"]);
});

test("normalizar ignora tildes y mayusculas", () => {
  assert.equal(normalizar("HUÁNUCO"), "huanuco");
  assert.equal(normalizar("  Percepción  "), "percepcion");
});

test("filaAObjeto tolera filas mas cortas y mas largas que el encabezado", () => {
  assert.deepEqual(filaAObjeto(["a", "b", "c"], ["1", "2"]), { a: "1", b: "2", c: "" });
  assert.deepEqual(filaAObjeto(["a"], ["1", "2"]), { a: "1", extra_2: "2" });
});
