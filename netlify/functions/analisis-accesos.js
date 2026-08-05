// netlify/functions/analisis-accesos.js
//
// Consulta la API de ZKBio CVSecurity (endpoint api/v2/transaction/list) para
// un rango de fechas, se queda solo con los eventos de COLABORADORES (pin de
// 6 dígitos que empieza con "90" — el patrón usado en esta operación:
// ID real de 4 dígitos + prefijo "90"), y regresa TODOS los campos del
// módulo de accesos para que el dashboard pueda filtrar por sede, dispositivo,
// lector, modo de verificación, tipo/nivel de evento, departamento e ID.
//
// El cálculo de ventana ±10min e incidentes se hace en el navegador (frontend)
// sobre el set de eventos ya filtrado, para que los filtros sean instantáneos
// sin volver a llamar a ZKBio en cada cambio.
//
// Variables de entorno requeridas (configúralas en Netlify, nunca en el código):
//   ZKBIO_BASE_URL   ej. http://accesosalcaldia.ddns.net:8098
//   ZKBIO_API_TOKEN  el valor de "access_token" (tu CLAVE API)

const PAGE_SIZE = 1000;
const MAX_PAGES = 200; // límite de seguridad: 200,000 eventos por corrida

// Regla de negocio: un pin es de colaborador si son 6 dígitos y empieza con "90"
// (el ID real de 4 dígitos antecedido por "90"). Ajusta aquí si la regla cambia.
const PIN_COLABORADOR_REGEX = /^90\d{4}$/;

function isColaborador(pin) {
  return PIN_COLABORADOR_REGEX.test(String(pin || '').trim());
}

function pad(n) { return String(n).padStart(2, '0'); }

function defaultRange() {
  const end = new Date();
  const start = new Date(end.getTime() - 3 * 24 * 60 * 60 * 1000); // últimos 3 días (evita timeouts)
  const fmt = (d) =>
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  return { startDate: fmt(start), endDate: fmt(end) };
}

async function fetchAllTransactions(baseUrl, token, startDate, endDate) {
  const all = [];
  let pageNo = 1;
  const inicio = Date.now();
  // margen de seguridad: Netlify corta la función sola a los ~10s (plan gratis).
  // Nos detenemos antes, con un mensaje claro, en vez de dejar que Netlify la mate sin explicación.
  const LIMITE_MS = 8000;

  while (pageNo <= MAX_PAGES) {
    if (Date.now() - inicio > LIMITE_MS) {
      throw new Error(
        `Se acabó el tiempo consultando ZKBio (página ${pageNo}, ${all.length} eventos traídos). ` +
        `El rango de fechas es muy grande para una sola corrida — prueba con un rango más corto (1-3 días).`
      );
    }

    const url = new URL('/api/v2/transaction/list', baseUrl);
    url.searchParams.set('startDate', startDate);
    url.searchParams.set('endDate', endDate);
    url.searchParams.set('pageNo', String(pageNo));
    url.searchParams.set('pageSize', String(PAGE_SIZE));
    url.searchParams.set('access_token', token);

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 6000);
    let res;
    try {
      res = await fetch(url.toString(), { signal: controller.signal });
    } catch (e) {
      throw new Error(
        e.name === 'AbortError'
          ? `ZKBio no respondió a tiempo en la página ${pageNo} (¿el servidor está accesible desde internet en ese puerto?)`
          : `No se pudo conectar a ZKBio: ${e.message}`
      );
    } finally {
      clearTimeout(timeoutId);
    }

    if (!res.ok) {
      throw new Error(`ZKBio respondió ${res.status} en la página ${pageNo}`);
    }
    const json = await res.json();
    if (json.code !== 0) {
      throw new Error(`ZKBio error: ${json.message || 'desconocido'} (code ${json.code})`);
    }

    const page = json.data;
    all.push(...(page.data || []));

    if (page.lastPage || (page.data || []).length === 0) break;
    pageNo += 1;
  }
  return all;
}

function roundedHourISO(eventTime) {
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
  const { horaRedondeada, horaNumero, diffMin, dentroVentana } = roundedHourISO(t.eventTime);
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
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Content-Type': 'application/json',
  };

  try {
    const baseUrl = process.env.ZKBIO_BASE_URL;
    const token = process.env.ZKBIO_API_TOKEN;
    if (!baseUrl || !token) {
      return {
        statusCode: 500,
        headers,
        body: JSON.stringify({
          error: 'Faltan variables de entorno ZKBIO_BASE_URL o ZKBIO_API_TOKEN. Configúralas en Netlify (Site settings > Environment variables) y vuelve a desplegar (Trigger deploy > Clear cache and deploy site).',
        }),
      };
    }

    const qs = event.queryStringParameters || {};
    const { startDate, endDate } = qs.startDate && qs.endDate ? qs : defaultRange();

    const transactions = await fetchAllTransactions(baseUrl, token, startDate, endDate);
    const eventos = transactions
      .filter((t) => isColaborador(t.pin))
      .map(normalizar);

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        meta: {
          startDate,
          endDate,
          totalEventosConsultados: transactions.length,
          totalEventosColaboradores: eventos.length,
          generadoEn: new Date().toISOString(),
        },
        eventos,
      }),
    };
  } catch (err) {
    return {
      statusCode: 502,
      headers,
      body: JSON.stringify({ error: err.message || 'Error consultando ZKBio' }),
    };
  }
};
