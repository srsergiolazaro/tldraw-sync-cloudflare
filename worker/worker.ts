import { handleUnfurlRequest } from 'cloudflare-workers-unfurl'
import { AutoRouter, error, IRequest } from 'itty-router'
import { handleAssetDownload, handleAssetUpload } from './assetUploads'

// make sure our sync durable object is made available to cloudflare
export { TldrawDurableObject } from './TldrawDurableObject'

// we use itty-router (https://itty.dev/) to handle routing. in this example we turn on CORS because
// we're hosting the worker separately to the client. you should restrict this to your own domain.

// cors helper
const cors =
	<T extends IRequest>(handler: (req: T, ...args: any[]) => any) =>
	async (req: T, ...args: any[]) => {
		const response = await handler(req, ...args)
		if (response instanceof Response) {
			const newHeaders = new Headers(response.headers)
			newHeaders.set('Access-Control-Allow-Origin', '*')
			newHeaders.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, PUT, DELETE')
			newHeaders.set(
				'Access-Control-Allow-Headers',
				'Content-Type, Authorization, X-Requested-With'
			)
			return new Response(response.body, {
				status: response.status,
				statusText: response.statusText,
				headers: newHeaders,
				webSocket: (response as any).webSocket,
			})
		}
		return response
	}

const router = AutoRouter<IRequest, [env: Env, ctx: ExecutionContext]>({
	catch: (e) => {
		console.error(e)
		return error(e)
	},
})
	.all('*', (req) => {
		if (req.method === 'OPTIONS') {
			const headers = new Headers()
			headers.set('Access-Control-Allow-Origin', '*')
			headers.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, PUT, DELETE')
			headers.set(
				'Access-Control-Allow-Headers',
				'Content-Type, Authorization, X-Requested-With'
			)
			return new Response(null, { headers })
		}
	})
	// requests to /connect are routed to the Durable Object, and handle realtime websocket syncing
	.get(
		'/api/connect/:roomId',
		cors((request, env) => {
			const id = env.TLDRAW_DURABLE_OBJECT.idFromName(request.params.roomId)
			const room = env.TLDRAW_DURABLE_OBJECT.get(id)
			return room.fetch(request.url, { headers: request.headers, body: request.body })
		})
	)

	// assets can be uploaded to the bucket under /uploads:
	.post('/api/uploads/:uploadId', cors(handleAssetUpload))

	// they can be retrieved from the bucket too:
	.get('/api/uploads/:uploadId', cors(handleAssetDownload))

	// bookmarks need to extract metadata from pasted URLs:
	.get('/api/unfurl', cors(handleUnfurlRequest))
	.all('*', () => {
		return new Response('Not found', { status: 404 })
	})

export default {
	fetch: router.fetch,
}
