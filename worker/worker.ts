import { handleUnfurlRequest } from "cloudflare-workers-unfurl";
import { AutoRouter, error, IRequest } from "itty-router";
import { handleAssetDownload, handleAssetUpload } from "./assetUploads";

// Asegúrate de que tu Durable Object esté exportado
export { TldrawDurableObject } from "./TldrawDurableObject";

// --- INICIO DE LA SECCIÓN CORS ---

// Configuración de CORS
const corsHeaders = {
  "Access-Control-Allow-Origin": "https://astro.taptapp.xyz, https://tldraw-worker-acadexia.sergiolazaromondargo.workers.dev",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, X-Session-Id",
};

// Responde a las peticiones OPTIONS (pre-flight)
const handleOptions = (request: IRequest) => {
  if (
    request.headers.get("Origin") !== null &&
    request.headers.get("Access-Control-Request-Method") !== null &&
    request.headers.get("Access-Control-Request-Headers") !== null
  ) {
    return new Response(null, { headers: corsHeaders });
  } else {
    return new Response(null, {
      headers: {
        Allow: "GET, POST, OPTIONS",
      },
    });
  }
};

// --- FIN DE LA SECCIÓN CORS ---

const router = AutoRouter<IRequest, [env: Env, ctx: ExecutionContext]>({
  // Manejador de OPTIONS para peticiones pre-flight
  before: [
    (request) => {
      if (request.method === "OPTIONS") {
        return handleOptions(request);
      }
    },
  ],
  // Envolvemos la respuesta final con las cabeceras CORS, excepto para WebSockets
  finally: [
    (response) => {
      // No modificar las cabeceras de una respuesta WebSocket (status 101)
      if (response.status === 101) {
        return response;
      }

      // Para todas las demás respuestas, añadimos las cabeceras CORS
      const newHeaders = new Headers(response.headers);
      for (const [key, value] of Object.entries(corsHeaders)) {
        if (!newHeaders.has(key)) {
          newHeaders.set(key, value);
        }
      }
      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers: newHeaders,
      });
    },
  ],
  catch: (e) => {
    console.error(e);
    return error(e);
  },
})
  // Las peticiones a /connect se enrutan al Durable Object
  .get("/api/connect/:roomId", (request, env) => {
    const id = env.TLDRAW_DURABLE_OBJECT.idFromName(request.params.roomId);
    const room = env.TLDRAW_DURABLE_OBJECT.get(id);
    // La conexión WebSocket es un "upgrade" de una petición HTTP,
    // por eso el manejador CORS debe funcionar para esta ruta GET.
    return room.fetch(request.url, {
      headers: request.headers,
      body: request.body,
    });
  })

  // Subida de assets al bucket
  .post("/api/uploads/:uploadId", handleAssetUpload)

  // Descarga de assets del bucket
  .get("/api/uploads/:uploadId", handleAssetDownload)

  // Los marcadores necesitan extraer metadatos de las URLs pegadas
  .get("/api/unfurl", handleUnfurlRequest)

  .all("*", () => {
    return new Response("Not found", { status: 404 });
  });

// El fetch del worker ahora usa el router configurado con CORS
export default {
  fetch: router.fetch,
};
