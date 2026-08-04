# Dashboard de Análisis de Accesos (colaboradores)

Mismo análisis que hicimos en Excel (ventana ±10 min, detección de 2+ accesos
del mismo colaborador en la misma ventana), pero alimentado en vivo desde la
API de **ZKBio CVSecurity** y mostrado en un dashboard interactivo, bajo demanda
(tú das clic en "Actualizar").

## Estructura

```
zkbio-dashboard/
├── netlify.toml
├── package.json
├── config/
│   └── colaboradores.json      # los 42 ID de colaboradores a vigilar
├── netlify/functions/
│   └── analisis-accesos.js     # backend: consulta ZKBio + aplica la lógica
└── public/
    └── index.html              # dashboard (KPIs, tabla de incidentes, ranking, heatmap)
```

## Cómo funciona

1. El navegador nunca habla directo con ZKBio — solo llama a `/api/analisis-accesos`
   (una Netlify Function).
2. La función lee `ZKBIO_BASE_URL` y `ZKBIO_API_TOKEN` de variables de entorno
   (nunca del código), pagina sobre `api/v2/transaction/list` hasta traer todos
   los eventos del rango de fechas pedido, filtra por los 42 ID de
   `config/colaboradores.json`, y corre la misma lógica del Excel.
3. Regresa un JSON ya resumido (KPIs, incidentes, ranking, matriz por hora) que
   el dashboard solo pinta.

## Configurar y desplegar

1. **Crea el repo** (o sube esta carpeta) a GitHub.
2. **Conéctalo a Netlify** (Sites > Add new site > Import from Git).
3. **Variables de entorno** — en Netlify: *Site settings > Environment variables*, agrega:
   - `ZKBIO_BASE_URL` → `http://accesosalcaldia.ddns.net:8098`
   - `ZKBIO_API_TOKEN` → tu clave API (la que me compartiste; no la pongas en
     ningún archivo del repo)
4. Deploy. El dashboard queda en `https://tu-sitio.netlify.app`.

### Probar en local

```bash
npm install -g netlify-cli
netlify dev
```

`netlify dev` lee un archivo `.env` local (créalo, no lo subas a git) con las
mismas dos variables, y sirve `public/` + las funciones juntos en `localhost:8888`.

## Notas importantes

- **HTTP, no HTTPS**: tu servidor ZKBio responde en `http://…:8098`, así que el
  `access_token` viaja sin cifrar por internet cuando Netlify lo consulta. Si en
  algún momento pueden poner un certificado (aunque sea autofirmado) o un túnel
  con TLS delante del servidor, vale la pena — ahora mismo cualquiera que
  intercepte ese tráfico se queda con el token.
- **Colaboradores**: si cambia la lista de IDs a vigilar, solo edita
  `config/colaboradores.json` y vuelve a desplegar (o usa "Trigger deploy" en Netlify).
- **Rango de fechas**: si no mandas `startDate`/`endDate`, la función usa los
  últimos 30 días por default.
- **Volumen**: la función pagina de 1000 en 1000 y se detiene a las 200 páginas
  (200,000 eventos) por corrida, como límite de seguridad para no colgar la
  función si pides un rango enorme. Si necesitas más historial, pide rangos
  más cortos y varias veces.
