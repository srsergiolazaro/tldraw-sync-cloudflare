import { handleUnfurlRequest } from "cloudflare-workers-unfurl";
import { AutoRouter, error, IRequest } from "itty-router";
import { handleAssetDownload, handleAssetUpload } from "./assetUploads";

// Asegúrate de que tu Durable Object esté exportado
export { TldrawDurableObject } from "./TldrawDurableObject";

// --- INICIO DE LA SECCIÓN CORS ---

// Configuración de CORS
// Get the allowed origins from environment variable or use a default
const ALLOWED_ORIGINS = [
  "https://astro.taptapp.xyz",
  "https://tldraw-worker-acadexia.sergiolazaromondargo.workers.dev",
];

// Helper function to get CORS headers
function getCorsHeaders(request: Request) {
  const origin = request.headers.get("Origin");
  const isAllowedOrigin = origin && ALLOWED_ORIGINS.includes(origin);

  return {
    "Access-Control-Allow-Origin": isAllowedOrigin
      ? origin
      : ALLOWED_ORIGINS[0],
    "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-Session-Id, *",
    "Access-Control-Allow-Credentials": "true",
    "Access-Control-Max-Age": "86400", // 24 hours
  };
}

// Handle OPTIONS (pre-flight) requests
const handleOptions = (request: IRequest) => {
  // Handle CORS preflight
  if (
    request.headers.get("Origin") !== null &&
    request.headers.get("Access-Control-Request-Method") !== null
  ) {
    return new Response(null, {
      headers: getCorsHeaders(request as unknown as Request),
    });
  }

  // Handle regular OPTIONS request
  return new Response(null, {
    headers: {
      Allow: "GET, POST, PUT, DELETE, OPTIONS",
      ...getCorsHeaders(request as unknown as Request),
    },
  });
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
    (response, request) => {
      // No modificar las cabeceras de una respuesta WebSocket (status 101)
      if (response.status === 101) return response;

      // Add CORS headers to all responses
      const headers = new Headers(response.headers);
      const corsHeaders = getCorsHeaders(request as unknown as Request);

      Object.entries(corsHeaders).forEach(([key, value]) => {
        if (value) headers.set(key, value);
      });

      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers,
      });

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
