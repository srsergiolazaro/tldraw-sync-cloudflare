import { error, IRequest } from 'itty-router'

// Helper function to strip the file extension
function stripExtension(filename: string): string {
    const lastDotIndex = filename.lastIndexOf('.');
    if (lastDotIndex === -1) {
        return filename;
    }
    return filename.substring(0, lastDotIndex);
}

// assets are stored in the bucket under the /uploads path
function getAssetObjectName(uploadId: string) {
	return `uploads/${uploadId.replace(/[^a-zA-Z0-9_-]+/g, '_')}`
}

declare global {
	interface CacheStorage {
		default: Cache
	}
}

// when a user uploads an asset, we store it in the bucket. we only allow image and video assets.
export async function handleAssetUpload(request: IRequest, env: Env) {
    const uploadIdWithoutExt = stripExtension(request.params.uploadId);
	const objectName = getAssetObjectName(uploadIdWithoutExt)

	const contentType = request.headers.get('content-type') ?? ''
	if (!contentType.startsWith('image/') && !contentType.startsWith('video/')) {
		return error(400, 'Invalid content type')
	}

	if (await env.TLDRAW_BUCKET.head(objectName)) {
		return error(409, 'Upload already exists')
	}

	await env.TLDRAW_BUCKET.put(objectName, request.body, {
		httpMetadata: request.headers,
	})

	return { ok: true }
}

// when a user downloads an asset, we retrieve it from the bucket. we also cache the response for performance.
export async function handleAssetDelete(request: IRequest, env: Env) {
	const uploadIds = request.params.uploadId.split(',').map(id => stripExtension(id.trim()))
	const results = {
		success: [] as string[],
		failures: [] as Array<{id: string, error: string}>
	}

	for (const uploadId of uploadIds) {
		try {
			const objectName = getAssetObjectName(uploadId)
			const object = await env.TLDRAW_BUCKET.head(objectName)
			
			if (!object) {
				results.failures.push({ id: uploadId, error: 'Asset not found' })
				continue
			}

			await env.TLDRAW_BUCKET.delete(objectName)

			// Invalidate cached response for this asset
			const cacheKey = `/api/uploads/${uploadId}`
			await caches.default.delete(cacheKey)

			results.success.push(uploadId)
		} catch (error) {
			results.failures.push({ 
				id: uploadId, 
				error: error instanceof Error ? error.message : 'Unknown error' 
			})
		}
	}

	// If all operations failed, return an error
	if (results.success.length === 0 && results.failures.length > 0) {
		return error(404, {
			success: false,
			errors: results.failures
		})
	}

	return { 
		ok: true, 
		success: results.success,
		failures: results.failures.length > 0 ? results.failures : undefined
	}
}

export async function handleAssetDownload(request: IRequest, env: Env, ctx: ExecutionContext) {
	const objectName = getAssetObjectName(request.params.uploadId)

	// if we have a cached response for this request (automatically handling ranges etc.), return it
	const cacheKey = new Request(request.url, { headers: request.headers })
	const cachedResponse = await caches.default.match(cacheKey)
	if (cachedResponse) {
		return cachedResponse
	}

	// if not, we try to fetch the asset from the bucket
	const object = await env.TLDRAW_BUCKET.get(objectName, {
		range: request.headers,
		onlyIf: request.headers,
	})

	if (!object) {
		return error(404)
	}

	// write the relevant metadata to the response headers
	const headers = new Headers()
	object.writeHttpMetadata(headers)

	// assets are immutable, so we can cache them basically forever:
	headers.set('cache-control', 'public, max-age=31536000, immutable')
	headers.set('etag', object.httpEtag)

	// CORS headers are handled by the router's finally hook in worker.ts

	// cloudflare doesn't set the content-range header automatically in writeHttpMetadata, so we
	// need to do it ourselves.
	let contentRange
	if (object.range) {
		if ('suffix' in object.range) {
			const start = object.size - object.range.suffix
			const end = object.size - 1
			contentRange = `bytes ${start}-${end}/${object.size}`
		} else {
			const start = object.range.offset ?? 0
			const end = object.range.length ? start + object.range.length - 1 : object.size - 1
			if (start !== 0 || end !== object.size - 1) {
				contentRange = `bytes ${start}-${end}/${object.size}`
			}
		}
	}

	if (contentRange) {
		headers.set('content-range', contentRange)
	}

	// make sure we get the correct body/status for the response
	const body = 'body' in object && object.body ? object.body : null
	const status = body ? (contentRange ? 206 : 200) : 304

	// we only cache complete (200) responses
	if (status === 200) {
		const [cacheBody, responseBody] = body!.tee()
		ctx.waitUntil(caches.default.put(cacheKey, new Response(cacheBody, { headers, status })))
		return new Response(responseBody, { headers, status })
	}

	return new Response(body, { headers, status })
}
