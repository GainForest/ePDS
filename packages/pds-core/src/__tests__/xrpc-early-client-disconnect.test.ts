import { createServer as createHttpServer, get as httpGet } from 'node:http'
import type {
  IncomingMessage,
  Server as HttpServer,
  ServerResponse,
} from 'node:http'
import { createRequire } from 'node:module'
import type { Socket } from 'node:net'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'

const pdsEntry = createRequire(import.meta.url).resolve('@atproto/pds')
const requireFromPds = createRequire(pdsEntry)
const xrpcServerPath = requireFromPds.resolve('@atproto/xrpc-server')
const { Server: XrpcServer } = await import(pathToFileURL(xrpcServerPath).href)

const ROUTE = 'com.example.blob.get'
const BLOB = Buffer.from('fake-storage-blob')
const TIMEOUT_MS = 1_500

type Deferred<T> = {
  promise: Promise<T>
  resolve: (value: T | PromiseLike<T>) => void
}

function deferred<T>(): Deferred<T> {
  let resolve!: Deferred<T>['resolve']
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

async function within<T>(promise: Promise<T>, label: string): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => {
          reject(new Error(`Timed out waiting for ${label}`))
        }, TIMEOUT_MS)
        timeout.unref()
      }),
    ])
  } finally {
    if (timeout) clearTimeout(timeout)
  }
}

async function listen(server: HttpServer): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
}

async function closeServer(
  server: HttpServer,
  sockets: Set<Socket>,
): Promise<void> {
  for (const socket of sockets) socket.destroy()
  if (!server.listening) return
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error)
      else resolve()
    })
  })
}

async function createHarness(delayStorageHeaders: boolean) {
  const storageRequestStarted = deferred<undefined>()
  const storageResponseClosed = deferred<boolean>()
  const storageSocketClosed = deferred<undefined>()
  const downstreamResponseClosed = deferred<{
    destroyed: boolean
    closed: boolean
  }>()
  const storageBodyReturned = deferred<IncomingMessage>()
  const storageSockets = new Set<Socket>()
  const downstreamSockets = new Set<Socket>()
  let storageHeadersSent = false
  let sendStorageHeaders: () => void = () => {
    throw new Error(
      'Storage request did not reach the delayed-response handler',
    )
  }

  const storage = createHttpServer((_request, response) => {
    response.once('close', () => {
      storageResponseClosed.resolve(response.writableFinished)
    })
    sendStorageHeaders = () => {
      storageHeadersSent = true
      response.writeHead(200, { 'content-type': 'application/octet-stream' })
      response.write(BLOB)
    }
    storageRequestStarted.resolve(undefined)

    if (!delayStorageHeaders) {
      sendStorageHeaders()
      response.end()
    }
  })
  storage.on('connection', (socket: Socket) => {
    storageSockets.add(socket)
    socket.once('close', () => {
      storageSockets.delete(socket)
      storageSocketClosed.resolve(undefined)
    })
  })
  await listen(storage)

  const storageAddress = storage.address()
  if (!storageAddress || typeof storageAddress === 'string') {
    throw new Error('Expected the fake storage server to have a TCP address')
  }
  const storageUrl = `http://127.0.0.1:${storageAddress.port}/blob`

  const xrpc = new XrpcServer(undefined, { validateResponse: false })
  xrpc.addLexicon({
    lexicon: 1,
    id: ROUTE,
    defs: { main: { type: 'query' } },
  })
  xrpc.method(ROUTE, async ({ res }: { res: ServerResponse }) => {
    res.once('close', () => {
      downstreamResponseClosed.resolve({
        destroyed: res.destroyed,
        closed: res.closed,
      })
    })
    const body = await new Promise<IncomingMessage>((resolve, reject) => {
      httpGet(storageUrl, { agent: false }, resolve).once('error', reject)
    })
    storageBodyReturned.resolve(body)
    return { encoding: 'application/octet-stream', body }
  })

  const downstream = xrpc.listen(0, '127.0.0.1') as HttpServer
  downstream.on('connection', (socket: Socket) => {
    downstreamSockets.add(socket)
    socket.once('close', () => downstreamSockets.delete(socket))
  })
  await listen(downstream)

  const downstreamAddress = downstream.address()
  if (!downstreamAddress || typeof downstreamAddress === 'string') {
    throw new Error('Expected the XRPC server to have a TCP address')
  }

  return {
    endpoint: `http://127.0.0.1:${downstreamAddress.port}/xrpc/${ROUTE}`,
    storageRequestStarted: storageRequestStarted.promise,
    storageResponseClosed: storageResponseClosed.promise,
    storageSocketClosed: storageSocketClosed.promise,
    downstreamResponseClosed: downstreamResponseClosed.promise,
    storageBodyReturned: storageBodyReturned.promise,
    get storageHeadersSent() {
      return storageHeadersSent
    },
    sendStorageHeaders: () => {
      sendStorageHeaders()
    },
    close: async () => {
      await Promise.all([
        closeServer(downstream, downstreamSockets),
        closeServer(storage, storageSockets),
      ])
    },
  }
}

describe('XRPC response streams after an early client disconnect', () => {
  it('destroys the storage stream if the client disconnects before storage headers arrive', async () => {
    const harness = await createHarness(true)
    const clientRequest = httpGet(harness.endpoint, { agent: false })
    clientRequest.once('error', () => {})

    try {
      await within(harness.storageRequestStarted, 'the fake storage request')
      expect(harness.storageHeadersSent).toBe(false)

      clientRequest.destroy()
      await expect(
        within(harness.downstreamResponseClosed, 'the downstream disconnect'),
      ).resolves.toMatchObject({ destroyed: true, closed: true })
      expect(harness.storageHeadersSent).toBe(false)

      harness.sendStorageHeaders()
      const body = await within(
        harness.storageBodyReturned,
        'the storage stream returned by the XRPC handler',
      )
      await within(
        harness.storageSocketClosed,
        'the upstream storage socket close',
      )
      const storageFinished = await within(
        harness.storageResponseClosed,
        'the upstream storage response close',
      )

      expect(body.destroyed).toBe(true)
      expect(storageFinished).toBe(false)
      expect(harness.storageHeadersSent).toBe(true)
    } finally {
      await harness.close()
    }
  })

  it('streams the complete blob response when the client stays connected', async () => {
    const harness = await createHarness(false)

    try {
      const response = await new Promise<{
        statusCode: number | undefined
        body: Buffer
      }>((resolve, reject) => {
        const request = httpGet(
          harness.endpoint,
          { agent: false },
          (incoming) => {
            const chunks: Buffer[] = []
            incoming.on('data', (chunk: Buffer | string) => {
              chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
            })
            incoming.once('error', reject)
            incoming.once('end', () => {
              resolve({
                statusCode: incoming.statusCode,
                body: Buffer.concat(chunks),
              })
            })
          },
        )
        request.once('error', reject)
      })

      const body = await within(
        harness.storageBodyReturned,
        'the storage stream returned by the XRPC handler',
      )
      const storageFinished = await within(
        harness.storageResponseClosed,
        'the completed upstream storage response',
      )
      await within(
        harness.storageSocketClosed,
        'the upstream storage socket close',
      )

      expect(response.statusCode).toBe(200)
      expect(response.body).toEqual(BLOB)
      expect(storageFinished).toBe(true)
      expect(body.readableEnded).toBe(true)
    } finally {
      await harness.close()
    }
  })
})
