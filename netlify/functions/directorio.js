// netlify/functions/directorio.js
//
// Directorio de colaboradores para poblar los filtros ANTES de consultar accesos.
//
// Plan A: api/v2/person/getPersonList — se prueban varias variantes de la
// llamada porque distintas instalaciones de ZKBio responden distinto:
//   A1) POST con body JSON {pageNo,pageSize}, access_token en query string
//   A2) GET con pageNo/pageSize/access_token como query string
//   A3) POST con access_token también dentro del body
// Se usa la primera variante que regrese el formato esperado {code:0, data:{...}}.
//
// Plan B (si ninguna variante de A funciona): derivarlo escaneando
// transaction/list de los últimos N días — el mismo endpoint que ya sabemos
// que funciona — y quedándonos con la primera aparición de cada pin.
// Esto puede no incluir sedes/colaboradores sin accesos en ese periodo.
//
// Se queda solo con pines de colaborador (6 dígitos que empiezan con "90").

const PAGE_SIZE = 1000;
const PIN_COLABORADOR_REGEX = /^90\d{4}$/;

// Lista fija de las 18 sedes reales (tomada del árbol de departamentos de
// ZKBio). Se usa como respaldo para que el filtro de Departamento/Sede
// siempre muestre las 18, aunque el directorio derivado de accesos recientes
// no haya visto actividad de alguna de ellas todavía. Si algún nombre no
// coincide exactamente con el real, edítalo aquí.
const SEDES_CONOCIDAS = [
  'Alberca Olimpica', 'Gimnasio BJ', 'Joaquin Capilla', 'Vicente Saldivar',
  'Plan Sexenal', 'Nueva Argentina', 'Acopilco', 'Chimalpa', 'Cuauhximalpa',
  'Huizachito', 'San Mateo', 'Tinajas', 'Cuauhtemoc', 'Guelatao',
  'Antonio Caso', 'Bicentenario', 'Cinco De Mayo', 'Deportivo Morelos',
];
const DIAS_FALLBACK = 120;

function isColaborador(pin) {
  return PIN_COLABORADOR_REGEX.test(String(pin || '').trim());
}

function pad(n) { return String(n).padStart(2, '0'); }

async function fetchConTimeout(url, opts, timeoutMs) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...opts, signal: controller.signal });
  } finally {
    clearTimeout(timeoutId);
  }
}

async function unaPagina(baseUrl, token, pageNo, variante) {
  const url = new URL('/api/v2/person/getPersonList', baseUrl);
  let opts;
  if (variante === 'A2_GET') {
    url.searchParams.set('pageNo', String(pageNo));
    url.searchParams.set('pageSize', String(PAGE_SIZE));
    url.searchParams.set('access_token', token);
    opts = { method: 'GET' };
  } else {
    url.searchParams.set('access_token', token);
    const body = variante === 'A3_TOKEN_EN_BODY'
      ? { pageNo, pageSize: PAGE_SIZE, access_token: token }
      : { pageNo, pageSize: PAGE_SIZE };
    opts = { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
  }

  const res = await fetchConTimeout(url.toString(), opts, 8000);
  const raw = await res.text();
  let json;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new Error(`respuesta no-JSON (status ${res.status}): ${raw.slice(0, 150)}`);
  }
  if (!res.ok || json.code !== 0 || !json.data) {
    throw new Error(`formato inesperado (status ${res.status}): ${raw.slice(0, 400)}`);
  }
  return json.data;
}

async function intentarPersonList(baseUrl, token) {
  const variantes = ['A1_POST', 'A2_GET', 'A3_TOKEN_EN_BODY'];
  const errores = [];

  for (const variante of variantes) {
    try {
      const all = [];
      let pageNo = 1;
      while (pageNo <= 50) {
        const page = await unaPagina(baseUrl, token, pageNo, variante);
        all.push(...(page.data || []));
        if (page.lastPage || (page.data || []).length === 0) break;
        pageNo += 1;
      }
      return {
        variante,
        colaboradores: all.map((p) => ({
          id: String(p.pin), nombre: p.name || '', apellido: p.lastName || '', departamento: p.deptName || '',
        })),
      };
    } catch (e) {
      errores.push(`${variante}: ${e.message}`);
    }
  }
  throw new Error(errores.join(' | '));
}

// ---- Plan B: derivar del log de accesos reciente ----
async function derivarDeTransacciones(baseUrl, token) {
  const end = new Date();
  const start = new Date(end.getTime() - DIAS_FALLBACK * 24 * 60 * 60 * 1000);
  const fmt = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  const startDate = fmt(start);
  const endDate = fmt(end);

  const vistos = new Map();
  let pageNo = 1;
  const inicio = Date.now();
  const LIMITE_MS = 8000;

  while (pageNo <= 200) {
    if (Date.now() - inicio > LIMITE_MS) break;
    const url = new URL('/api/v2/transaction/list', baseUrl);
    url.searchParams.set('startDate', startDate);
    url.searchParams.set('endDate', endDate);
    url.searchParams.set('pageNo', String(pageNo));
    url.searchParams.set('pageSize', String(PAGE_SIZE));
    url.searchParams.set('access_token', token);

    const res = await fetchConTimeout(url.toString(), {}, 6000);
    if (!res.ok) break;
    const json = await res.json();
    if (json.code !== 0) break;
    const page = json.data;
    for (const t of page.data || []) {
      if (isColaborador(t.pin) && !vistos.has(t.pin)) {
        vistos.set(t.pin, { id: String(t.pin), nombre: t.name || '', apellido: t.lastName || '', departamento: t.deptName || '' });
      }
    }
    if (page.lastPage || (page.data || []).length === 0) break;
    pageNo += 1;
  }
  return [...vistos.values()];
}

exports.handler = async () => {
  const headers = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' };
  try {
    const baseUrl = process.env.ZKBIO_BASE_URL;
    const token = process.env.ZKBIO_API_TOKEN;
    if (!baseUrl || !token) {
      return { statusCode: 500, headers, body: JSON.stringify({ error: 'Faltan variables de entorno ZKBIO_BASE_URL o ZKBIO_API_TOKEN.' }) };
    }

    let colaboradores;
    let fuente;
    let detalle = null;
    try {
      const r = await intentarPersonList(baseUrl, token);
      colaboradores = r.colaboradores;
      fuente = 'directorio';
      detalle = `variante ${r.variante}`;
    } catch (eA) {
      try {
        colaboradores = await derivarDeTransacciones(baseUrl, token);
        fuente = 'derivado';
        detalle = `plan A falló (${eA.message}) — se usó accesos de los últimos ${DIAS_FALLBACK} días`;
      } catch (eB) {
        throw new Error(`Directorio no disponible (${eA.message}) y tampoco se pudo derivar de accesos (${eB.message})`);
      }
    }

    colaboradores = colaboradores.filter((c) => isColaborador(c.id)).sort((a, b) => a.id.localeCompare(b.id));

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        colaboradores,
        total: colaboradores.length,
        fuente,
        sedesConocidas: SEDES_CONOCIDAS,
        nota: fuente === 'derivado'
          ? `Derivado de accesos de los últimos ${DIAS_FALLBACK} días — puede no incluir sedes/colaboradores sin accesos en ese periodo. (${detalle})`
          : detalle,
      }),
    };
  } catch (err) {
    return { statusCode: 502, headers, body: JSON.stringify({ error: err.message || 'Error consultando ZKBio' }) };
  }
};
