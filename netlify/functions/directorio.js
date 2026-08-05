// netlify/functions/directorio.js
//
// Directorio de colaboradores para poblar los filtros ANTES de consultar accesos.
//
// Plan A: api/v2/person/getPersonList (maestro de personas, ligero).
// Plan B (si Plan A falla o esta instalación de ZKBio no lo soporta igual que
//         el manual): derivarlo escaneando transaction/list de los últimos
//         N días — el mismo endpoint que ya sabemos que funciona — y
//         quedándonos con la primera aparición de cada pin (nombre, apellido,
//         departamento). Esto puede no incluir colaboradores sin accesos
//         recientes, pero garantiza que el filtro funcione.
//
// Se queda solo con pines de colaborador (6 dígitos que empiezan con "90").

const PAGE_SIZE = 1000;
const PIN_COLABORADOR_REGEX = /^90\d{4}$/;
const DIAS_FALLBACK = 45;

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

// ---- Plan A ----
async function intentarPersonList(baseUrl, token) {
  const all = [];
  let pageNo = 1;
  while (pageNo <= 50) {
    const url = new URL('/api/v2/person/getPersonList', baseUrl);
    url.searchParams.set('access_token', token);
    const res = await fetchConTimeout(
      url.toString(),
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pageNo, pageSize: PAGE_SIZE }) },
      8000
    );
    const raw = await res.text();
    let json;
    try {
      json = JSON.parse(raw);
    } catch {
      throw new Error(`respuesta no-JSON: ${raw.slice(0, 150)}`);
    }
    if (!res.ok || json.code !== 0 || !json.data) {
      throw new Error(`formato inesperado (status ${res.status}, code ${json.code}, message ${json.message || 'n/a'})`);
    }
    const page = json.data;
    all.push(...(page.data || []));
    if (page.lastPage || (page.data || []).length === 0) break;
    pageNo += 1;
  }
  return all.map((p) => ({
    id: String(p.pin),
    nombre: p.name || '',
    apellido: p.lastName || '',
    departamento: p.deptName || '',
  }));
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
    if (Date.now() - inicio > LIMITE_MS) break; // nos quedamos con lo que ya juntamos
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
    try {
      colaboradores = await intentarPersonList(baseUrl, token);
      fuente = 'directorio';
    } catch (eA) {
      try {
        colaboradores = await derivarDeTransacciones(baseUrl, token);
        fuente = 'derivado';
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
        nota: fuente === 'derivado'
          ? `Derivado de accesos de los últimos ${DIAS_FALLBACK} días — puede no incluir colaboradores sin accesos recientes.`
          : null,
      }),
    };
  } catch (err) {
    return { statusCode: 502, headers, body: JSON.stringify({ error: err.message || 'Error consultando ZKBio' }) };
  }
};
