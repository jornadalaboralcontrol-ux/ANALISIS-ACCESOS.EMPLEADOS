// netlify/functions/analisis-accesos.js
//
// Dos modos:
//  - CON pins (query param "pins", coma-separado): consulta transaction/list
//    UNA VEZ POR CADA pin (personPin=), en paralelo controlado. Es rápido y
//    escala a cualquier rango de fechas porque solo trae el historial de la
//    gente puntual que elegiste en el directorio.
//  - SIN pins: escanea todo el rango de fechas (comportamiento anterior),
//    pensado solo para rangos cortos (1-3 días) como respaldo/exploración.
//
// En ambos casos se regresan TODOS los campos del módulo de accesos para que
// el dashboard pueda además refinar por sede, dispositivo, lector, modo de
// verificación, tipo y nivel de evento en el navegador.
//
// Variables de entorno requeridas:
//   ZKBIO_BASE_URL   ej. http://accesosalcaldia.ddns.net:8098
//   ZKBIO_API_TOKEN  el valor de "access_token" (tu CLAVE API)

const PAGE_SIZE = 1000;
const MAX_PAGES_POR_PIN = 20;
const MAX_PAGES_ESCANEO = 200;
const CONCURRENCIA_PINS = 5;
const PIN_COLABORADOR_REGEX = /^90\d{4}$/;

function isColaborador(pin) {
  return PIN_COLABORADOR_REGEX.test(String(pin || '').trim());
}

function pad(n) { return String(n).padStart(2, '0'); }

function defaultRange() {
  const end = new Date();
  const start = new Date(end.getTime() - 3 * 24 * 60 * 60 * 1000);
  const fmt = (d) =>
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  return { startDate: fmt(start), endDate: fmt(end) };
}

async function fetchJSON(url, opts, timeoutMs) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  let res;
  try {
    res = await fetch(url, { ...opts, signal: controller.signal });
  } catch (e) {
    throw new Error(e.name === 'AbortError' ? `ZKBio no respondió a tiempo (${url})` : `No se pudo conectar a ZKBio: ${e.message}`);
  } finally {
    clearTimeout(timeoutId);
  }
  if (!res.ok) throw new Error(`ZKBio respondió ${res.status}`);
  const json = await res.json();
  if (json.code !== 0) throw new Error(`ZKBio error: ${json.message || 'desconocido'} (code ${json.code})`);
  return json;
}

// ---- Modo dirigido: una persona a la vez ----
async function fetchTransaccionesDePin(baseUrl, token, pin, startDate, endDate) {
  const all = [];
  let pageNo = 1;
  while (pageNo <= MAX_PAGES_POR_PIN) {
    const url = new URL('/api/v2/transaction/list', baseUrl);
    url.searchParams.set('personPin', pin);
    url.searchParams.set('startDate', startDate);
    url.searchParams.set('endDate', endDate);
    url.searchParams.set('pageNo', String(pageNo));
    url.searchParams.set('pageSize', String(PAGE_SIZE));
    url.searchParams.set('access_token', token);

    const json = await fetchJSON(url.toString(), {}, 8000);
    const page = json.data;
    all.push(...(page.data || []));
    if (page.lastPage || (page.data || []).length === 0) break;
    pageNo += 1;
  }
  return all;
}

async function fetchPorPines(baseUrl, token, pins, startDate, endDate) {
  const resultados = [];
  for (let i = 0; i < pins.length; i += CONCURRENCIA_PINS) {
    const lote = pins.slice(i, i + CONCURRENCIA_PINS);
    const datosLote = await Promise.all(
      lote.map((pin) => fetchTransaccionesDePin(baseUrl, token, pin, startDate, endDate))
    );
    datosLote.forEach((d) => resultados.push(...d));
  }
  return resultados;
}

// ---- Modo escaneo: todo el rango, sin pin ----
async function fetchEscaneoCompleto(baseUrl, token, startDate, endDate) {
  const all = [];
  let pageNo = 1;
  const inicio = Date.now();
  const LIMITE_MS = 8000;

  while (pageNo <= MAX_PAGES_ESCANEO) {
    if (Date.now() - inicio > LIMITE_MS) {
      throw new Error(
        `Se acabó el tiempo escaneando ZKBio (página ${pageNo}, ${all.length} eventos traídos). ` +
        `Sin filtro de colaborador/departamento, el rango debe ser corto (1-3 días) — o mejor, filtra por colaborador o departamento antes de consultar.`
      );
    }
    const url = new URL('/api/v2/transaction/list', baseUrl);
    url.searchParams.set('startDate', startDate);
    url.searchParams.set('endDate', endDate);
    url.searchParams.set('pageNo', String(pageNo));
    url.searchParams.set('pageSize', String(PAGE_SIZE));
    url.searchParams.set('access_token', token);

    const json = await fetchJSON(url.toString(), {}, 6000);
    const page = json.data;
    all.push(...(page.data || []));
    if (page.lastPage || (page.data || []).length === 0) break;
    pageNo += 1;
  }
  return all;
}

function roundedHourInfo(eventTime) {
  const [datePart, timePart] = eventTime.split(' ');
  const [y, m, d] = datePart.split('-').map(Number);
  const [hh, mm, ss] = timePart.split(':').map(Number);
  const dt = new Date(y, m - 1, d, hh, mm, ss);
  if (dt.getMinutes() >= 30) dt.setHours(dt.getHours() + 1);
  dt.setMinutes(0, 0, 0);
  const diffMin = Math.round((new Date(y, m - 1, d, hh, mm, ss) - dt) / 6000) / 10;
  return {
    horaRedondeada: `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())} ${pad(dt.getHours())}:00`,
    horaNumero: dt.getHours(),
    diffMin,
    dentroVentana: Math.abs(diffMin) <= 10,
  };
}

function normalizar(t) {
  const { horaRedondeada, horaNumero, diffMin, dentroVentana } = roundedHourInfo(t.eventTime);
  return {
    id: String(t.pin || ''),
    nombre: t.name || '',
    apellido: t.lastName || '',
    departamento: t.deptName || '',
    area: t.areaName || '',
    tarjeta: t.cardNo || '',
    dispositivo: t.devName || '',
    devSn: t.devSn || '',
    lector: t.readerName || '',
    puntoEvento: t.eventPointName || '',
    puerta: t.doorName || '',
    modoVerificacion: t.verifyModeName || '',
    tipoEvento: t.eventName || '',
    eventNo: t.eventNo,
    nivelEvento: t.eventLevel === 0 || t.eventLevel === '0' ? 'Normal' : (t.eventLevel === 1 || t.eventLevel === '1' ? 'Excepción' : 'Alarma'),
    tiempo: t.eventTime,
    fecha: t.eventTime.split(' ')[0],
    horaRedondeada,
    horaNumero,
    diffMin,
    dentroVentana,
  };
}

exports.handler = async (event) => {
  const headers = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' };

  try {
    const baseUrl = process.env.ZKBIO_BASE_URL;
    const token = process.env.ZKBIO_API_TOKEN;
    if (!baseUrl || !token) {
      return {
        statusCode: 500,
        headers,
        body: JSON.stringify({
          error: 'Faltan variables de entorno ZKBIO_BASE_URL o ZKBIO_API_TOKEN. Configúralas en Netlify y vuelve a desplegar (Trigger deploy > Clear cache and deploy site).',
        }),
      };
    }

    const qs = event.queryStringParameters || {};
    const { startDate, endDate } = qs.startDate && qs.endDate ? qs : defaultRange();
    const pins = (qs.pins || '')
      .split(',')
      .map((s) => s.trim())
      .filter((s) => isColaborador(s));

    const modo = pins.length > 0 ? 'dirigido' : 'escaneo';
    const transactions =
      modo === 'dirigido'
        ? await fetchPorPines(baseUrl, token, pins, startDate, endDate)
        : await fetchEscaneoCompleto(baseUrl, token, startDate, endDate);

    const eventos = transactions.filter((t) => isColaborador(t.pin)).map(normalizar);

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        meta: {
          startDate,
          endDate,
          modo,
          pinsConsultados: pins,
          totalEventosConsultados: transactions.length,
          totalEventosColaboradores: eventos.length,
          generadoEn: new Date().toISOString(),
        },
        eventos,
      }),
    };
  } catch (err) {
    return { statusCode: 502, headers, body: JSON.stringify({ error: err.message || 'Error consultando ZKBio' }) };
  }
};
