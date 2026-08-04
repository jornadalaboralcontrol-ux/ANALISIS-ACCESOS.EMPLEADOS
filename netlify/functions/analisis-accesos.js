// netlify/functions/analisis-accesos.js
//
// Consulta la API de ZKBio CVSecurity (endpoint api/v2/transaction/list),
// filtra por los ID de colaboradores configurados en config/colaboradores.json,
// y aplica la misma lógica del análisis en Excel:
//   - redondea cada acceso a la hora más cercana
//   - marca si cae dentro de la ventana ±10 min
//   - agrupa por (colaborador, fecha, hora) y marca "incidente" cuando hay 2+ accesos
//
// Variables de entorno requeridas (configúralas en Netlify, nunca en el código):
//   ZKBIO_BASE_URL   ej. http://accesosalcaldia.ddns.net:8098
//   ZKBIO_API_TOKEN  el valor de "access_token" (tu CLAVE API)
//
// Uso: GET /.netlify/functions/analisis-accesos?startDate=2026-07-01 00:00:00&endDate=2026-08-04 23:59:59

const colaboradores = require('../../config/colaboradores.json');

const PAGE_SIZE = 1000;
const VENTANA_MIN = 10;

function pad(n) { return String(n).padStart(2, '0'); }

function defaultRange() {
  const end = new Date();
  const start = new Date(end.getTime() - 30 * 24 * 60 * 60 * 1000); // últimos 30 días
  const fmt = (d) =>
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  return { startDate: fmt(start), endDate: fmt(end) };
}

async function fetchAllTransactions(baseUrl, token, startDate, endDate) {
  const all = [];
  let pageNo = 1;
  // seguridad: nunca más de 200 páginas (200,000 registros) por corrida
  const MAX_PAGES = 200;

  while (pageNo <= MAX_PAGES) {
    const url = new URL('/api/v2/transaction/list', baseUrl);
    url.searchParams.set('startDate', startDate);
    url.searchParams.set('endDate', endDate);
    url.searchParams.set('pageNo', String(pageNo));
    url.searchParams.set('pageSize', String(PAGE_SIZE));
    url.searchParams.set('access_token', token);

    const res = await fetch(url.toString());
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

function parseEventTime(s) {
  // formato esperado: "yyyy-MM-dd HH:mm:ss"
  const [datePart, timePart] = s.split(' ');
  const [y, m, d] = datePart.split('-').map(Number);
  const [hh, mm, ss] = timePart.split(':').map(Number);
  return new Date(y, m - 1, d, hh, mm, ss);
}

function roundedHour(dt) {
  const d = new Date(dt);
  if (d.getMinutes() >= 30) {
    d.setHours(d.getHours() + 1);
  }
  d.setMinutes(0, 0, 0);
  return d;
}

function analizar(transactions, colaboradorSet) {
  const eventos = transactions
    .filter((t) => colaboradorSet.has(String(t.pin)))
    .map((t) => {
      const tiempo = parseEventTime(t.eventTime);
      const rh = roundedHour(tiempo);
      const diffMin = (tiempo.getTime() - rh.getTime()) / 60000;
      const dentroVentana = Math.abs(diffMin) <= VENTANA_MIN;
      return {
        id: String(t.pin),
        nombre: t.name || '',
        apellido: t.lastName || '',
        departamento: t.deptName || '',
        dispositivo: t.devName || '',
        lector: t.readerName || '',
        tiempo: t.eventTime,
        horaRedondeada: rh,
        diffMin: Math.round(diffMin * 10) / 10,
        dentroVentana,
        horaNumero: rh.getHours(),
        fecha: t.eventTime.split(' ')[0],
      };
    });

  // agrupar por colaborador+fecha+horaRedondeada
  const grupos = new Map();
  for (const ev of eventos) {
    if (!ev.dentroVentana) continue;
    const key = `${ev.id}|${ev.fecha}|${ev.horaRedondeada.toISOString()}`;
    if (!grupos.has(key)) grupos.set(key, []);
    grupos.get(key).push(ev);
  }

  // detalle de incidentes (2+ en la misma ventana)
  const incidentes = [];
  for (const [, lista] of grupos) {
    if (lista.length < 2) continue;
    const ordenada = [...lista].sort((a, b) => a.tiempo.localeCompare(b.tiempo));
    const primero = parseEventTime(ordenada[0].tiempo);
    const ultimo = parseEventTime(ordenada[ordenada.length - 1].tiempo);
    incidentes.push({
      id: ordenada[0].id,
      nombre: ordenada[0].nombre,
      apellido: ordenada[0].apellido,
      departamento: ordenada[0].departamento,
      fecha: ordenada[0].fecha,
      horaVentana: `${pad(ordenada[0].horaRedondeada.getHours())}:00`,
      cantidad: ordenada.length,
      horarios: ordenada.map((e) => e.tiempo.split(' ')[1]),
      rangoMinutos: Math.round(((ultimo - primero) / 60000) * 10) / 10,
      dispositivos: [...new Set(ordenada.map((e) => e.dispositivo))],
    });
  }
  incidentes.sort((a, b) => b.cantidad - a.cantidad);

  // resumen por colaborador
  const porColaborador = new Map();
  for (const ev of eventos) {
    if (!porColaborador.has(ev.id)) {
      porColaborador.set(ev.id, {
        id: ev.id,
        nombre: ev.nombre,
        apellido: ev.apellido,
        departamento: ev.departamento,
        total: 0,
        enVentana: 0,
        horas: {},
      });
    }
    const c = porColaborador.get(ev.id);
    c.total += 1;
    if (ev.dentroVentana) {
      c.enVentana += 1;
      c.horas[ev.horaNumero] = (c.horas[ev.horaNumero] || 0) + 1;
    }
  }
  for (const inc of incidentes) {
    const c = porColaborador.get(inc.id);
    if (c) {
      c.incidentes = (c.incidentes || 0) + 1;
      c.maxEnVentana = Math.max(c.maxEnVentana || 0, inc.cantidad);
    }
  }
  const resumenColaborador = [...porColaborador.values()]
    .map((c) => ({ ...c, incidentes: c.incidentes || 0, maxEnVentana: c.maxEnVentana || 0 }))
    .sort((a, b) => (b.incidentes - a.incidentes) || (b.maxEnVentana - a.maxEnVentana));

  // matriz colaborador x hora
  const horasUsadas = [...new Set(eventos.filter((e) => e.dentroVentana).map((e) => e.horaNumero))].sort(
    (a, b) => a - b
  );
  const matrizHora = resumenColaborador.map((c) => ({
    id: c.id,
    nombre: c.nombre,
    apellido: c.apellido,
    valores: horasUsadas.map((h) => c.horas[h] || 0),
  }));

  return {
    totalEventosColaboradores: eventos.length,
    totalEnVentana: eventos.filter((e) => e.dentroVentana).length,
    totalIncidentes: incidentes.length,
    resumenColaborador,
    incidentes,
    matrizHora: { horas: horasUsadas, filas: matrizHora },
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
          error: 'Faltan variables de entorno ZKBIO_BASE_URL o ZKBIO_API_TOKEN. Configúralas en Netlify (Site settings > Environment variables).',
        }),
      };
    }

    const qs = event.queryStringParameters || {};
    const { startDate, endDate } = qs.startDate && qs.endDate ? qs : defaultRange();

    const colaboradorSet = new Set(colaboradores);
    const transactions = await fetchAllTransactions(baseUrl, token, startDate, endDate);
    const resultado = analizar(transactions, colaboradorSet);

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        meta: {
          startDate,
          endDate,
          totalEventosConsultados: transactions.length,
          totalColaboradores: colaboradores.length,
          generadoEn: new Date().toISOString(),
        },
        ...resultado,
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
