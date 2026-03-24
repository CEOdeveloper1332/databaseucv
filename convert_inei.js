/**
 * convert_inei.js
 * Convierte el CSV de Centros Poblados del INEI a JSON minificado
 * para uso como geocoder local embebido en el HTML.
 *
 * Uso:
 *   node convert_inei.js centros_poblados.csv peru_geo.json
 *
 * Fuente: https://www.inei.gob.pe/media/MenuRecursivo/publicaciones_digitales/
 *         (Dataset de Centros Poblados con coordenadas)
 *
 * El CSV del INEI suele tener estas columnas (verificar con tu descarga):
 *   UBIGEO, DEPARTAMENTO, PROVINCIA, DISTRITO, CENTRO_POBLADO, LATITUD, LONGITUD, ALTITUD, TIPO
 *
 * Salida por registro: [nombre_lower, lat, lng, tipo, departamento]
 */

const fs   = require('fs');
const path = require('path');
const rl   = require('readline');

// ── CONFIGURACIÓN ─────────────────────────────────────────────────────────────
// Ajusta estos índices si las columnas de tu CSV son diferentes.
// Ejecuta primero: node convert_inei.js centros_poblados.csv /dev/null --preview
// para ver las primeras 5 filas y confirmar posiciones.
const COL = {
  nombre:  4,   // CENTRO_POBLADO (nombre del lugar)
  lat:     5,   // LATITUD
  lng:     6,   // LONGITUD
  tipo:    8,   // TIPO (ciudad, pueblo, caserío, etc.)
  depto:   1,   // DEPARTAMENTO
};

// Separador del CSV (puede ser ; en algunos exports del INEI)
const SEP = ',';

// Si la primera línea es header, la saltamos
const SKIP_HEADER = true;

// Tipos a incluir (vacío = todos). Filtra si quieres solo ciudades grandes.
// Ejemplos de valores INEI: "CIUDAD", "PUEBLO", "CASERIO", "ANEXO", "CENTRO POBLADO"
const INCLUDE_TYPES = []; // [] = incluir todos

// Bounding box de Perú — filtra registros con coords fuera del país
const BOUNDS = { latMin: -18.4, latMax: -0.0, lngMin: -81.4, lngMax: -68.6 };
// ─────────────────────────────────────────────────────────────────────────────

const inputFile  = process.argv[2] || 'centros_poblados.csv';
const outputFile = process.argv[3] || 'peru_geo.json';
const preview    = process.argv.includes('--preview');

if (!fs.existsSync(inputFile)) {
  console.error(`\nERROR: No se encuentra el archivo: ${inputFile}`);
  console.error('Descarga el dataset de centros poblados del INEI y colócalo en esta carpeta.\n');
  process.exit(1);
}

const stream = fs.createReadStream(inputFile, { encoding: 'utf8' });
const reader = rl.createInterface({ input: stream });

const result  = [];
const typeSet = new Set();
let   lineNum = 0;
let   skipped = 0;
let   errors  = 0;

// Normalizar texto: minúsculas, sin tildes
function normalize(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim();
}

// Mapear tipos a valores cortos
function mapTipo(t) {
  const n = normalize(t);
  if (n.includes('ciudad'))   return 'ciudad';
  if (n.includes('pueblo'))   return 'pueblo';
  if (n.includes('caserio') || n.includes('caserio')) return 'caserio';
  if (n.includes('anexo'))    return 'anexo';
  if (n.includes('comunidad')) return 'comunidad';
  if (n.includes('barrio'))   return 'barrio';
  if (n.includes('centro'))   return 'centro';
  if (n.includes('distrito')) return 'distrito';
  if (n.includes('capital'))  return 'capital';
  return n || 'otro';
}

reader.on('line', (line) => {
  lineNum++;

  if (SKIP_HEADER && lineNum === 1) {
    if (preview) console.log('HEADER:', line.split(SEP));
    return;
  }

  // Preview: mostrar primeras 5 filas y salir
  if (preview && lineNum <= 6) {
    const cols = line.split(SEP);
    console.log(`\nFila ${lineNum}:`);
    cols.forEach((c, i) => console.log(`  [${i}] ${c.trim()}`));
    if (lineNum === 6) {
      console.log('\nAjusta los índices COL en el script según lo que ves arriba.');
      process.exit(0);
    }
    return;
  }

  const cols = line.split(SEP);

  const raw_nombre = cols[COL.nombre];
  const raw_lat    = cols[COL.lat];
  const raw_lng    = cols[COL.lng];
  const raw_tipo   = cols[COL.tipo];
  const raw_depto  = cols[COL.depto];

  if (!raw_nombre || !raw_lat || !raw_lng) { skipped++; return; }

  const nombre = normalize(raw_nombre);
  const lat    = parseFloat(raw_lat);
  const lng    = parseFloat(raw_lng);
  const tipo   = mapTipo(raw_tipo);
  const depto  = normalize(raw_depto);

  if (!nombre || isNaN(lat) || isNaN(lng)) { skipped++; return; }

  // Filtrar fuera de Perú
  if (lat < BOUNDS.latMin || lat > BOUNDS.latMax ||
      lng < BOUNDS.lngMin || lng > BOUNDS.lngMax) {
    skipped++;
    return;
  }

  // Filtrar por tipo si hay lista
  if (INCLUDE_TYPES.length && !INCLUDE_TYPES.includes(tipo)) {
    skipped++;
    return;
  }

  typeSet.add(tipo);

  // Formato final: [nombre, lat, lng, tipo, depto]
  // lat/lng con 4 decimales (~11m precisión, suficiente para geocoding)
  result.push([nombre, parseFloat(lat.toFixed(4)), parseFloat(lng.toFixed(4)), tipo, depto]);
});

reader.on('close', () => {
  if (preview) return;

  if (result.length === 0) {
    console.error('\nERROR: No se procesaron registros. Verifica los índices de columna.');
    console.error('Tip: ejecuta con --preview para inspeccionar las columnas.\n');
    process.exit(1);
  }

  // Escribir JSON minificado
  const json = JSON.stringify(result);
  fs.writeFileSync(outputFile, json, 'utf8');

  const sizeKB = (fs.statSync(outputFile).size / 1024).toFixed(0);

  console.log('\n✓ Conversión completada');
  console.log(`  Registros procesados : ${result.length.toLocaleString()}`);
  console.log(`  Registros omitidos   : ${skipped.toLocaleString()}`);
  console.log(`  Tipos encontrados    : ${[...typeSet].join(', ')}`);
  console.log(`  Archivo generado     : ${outputFile} (${sizeKB} KB)`);
  console.log(`  Siguiente paso       : embebe peru_geo.json en el HTML\n`);
});

reader.on('error', (e) => {
  console.error('Error leyendo el archivo:', e.message);
  process.exit(1);
});