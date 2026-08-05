// netlify/functions/directorio.js
//
// Trae el directorio de personas (api/v2/person/getPersonList) — NO eventos,
// solo datos maestros (pin, nombre, departamento). Es una llamada mucho más
// ligera que escanear el log de accesos, y sirve para poblar los filtros del
// dashboard ANTES de pedir accesos, para que esa consulta sea puntual.
//
// Se queda solo con los pines de colaborador (6 dígitos que empiezan con "90").

const PAGE_SIZE = 1000;
const MAX_PAGES = 50;
const PIN_COLABORADOR_REGEX = /^90\d{4}$/;

function isColaborador(pin) {
  return PIN_COLABORADOR_REGEX.test(String(pin || '').trim());
}

async function fetchAllPersons(baseUrl, token) {
  const all = [];
  let pageNo = 1;
  while (pageNo <= MAX_PAGES) {
    const url = new URL('/api/v2/person/getPersonList', baseUrl);
    url.searchParams.set('access_token', token);

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 8000);
    let res;
    try {
      res = await fetch(url.toString(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pageNo, pageSize: PAGE_SIZE }),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeoutId);
    }

    if (!res.ok) throw new Error(`ZKBio respondió ${res.status} pidiendo el directorio (página ${pageNo})`);
    const json = await res.json();
    if (json.code !== 0) throw new Error(`ZKBio error: ${json.message || 'desconocido'} (code ${json.code})`);

    const page = json.data;
    all.push(...(page.data || []));
    if (page.lastPage || (page.data || []).length === 0) break;
    pageNo += 1;
  }
  return all;
}

exports.handler = async () => {
  const headers = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' };
  try {
    const baseUrl = process.env.ZKBIO_BASE_URL;
    const token = process.env.ZKBIO_API_TOKEN;
    if (!baseUrl || !token) {
      return {
        statusCode: 500,
        headers,
        body: JSON.stringify({ error: 'Faltan variables de entorno ZKBIO_BASE_URL o ZKBIO_API_TOKEN.' }),
      };
    }

    const personas = await fetchAllPersons(baseUrl, token);
    const colaboradores = personas
      .filter((p) => isColaborador(p.pin))
      .map((p) => ({
        id: String(p.pin),
        nombre: p.name || '',
        apellido: p.lastName || '',
        departamento: p.deptName || '',
        deptCode: p.deptCode || '',
      }))
      .sort((a, b) => a.id.localeCompare(b.id));

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ colaboradores, total: colaboradores.length }),
    };
  } catch (err) {
    return { statusCode: 502, headers, body: JSON.stringify({ error: err.message || 'Error consultando ZKBio' }) };
  }
};
