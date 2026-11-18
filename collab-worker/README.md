# Excalidraw collab worker

Live collaboration and shareable links for this Excalidraw app, running on Cloudflare Workers + SQLite-backed Durable Objects (works on the free plan).

Everything is **end-to-end encrypted** in the browser: the worker only relays and stores ciphertext. Room and link keys stay in the URL `#hash` and never reach the server.

| Durable Object | One per | Does |
| --- | --- | --- |
| `CollabRoom` | collab room | relays the room's WebSocket messages; stores the encrypted scene (revisioned) and image files |
| `SharedScene` | shareable link | stores the encrypted snapshot and its image files |

## Run locally

```sh
cd collab-worker
npm install
npx wrangler dev        # http://localhost:8787
```

`.env.development` points the app at it (`VITE_APP_COLLAB_WORKER_URL=http://localhost:8787`). Restart `yarn start` after changing `.env` files.

## Deploy

```sh
cd collab-worker
npx wrangler login
# add your app's origin(s) to ALLOWED_ORIGINS in wrangler.jsonc, e.g.
#   "http://localhost:3000,https://draw.example.com"
npx wrangler deploy     # prints https://excalidraw-collab.<subdomain>.workers.dev
```

Then set `VITE_APP_COLLAB_WORKER_URL` to that URL in `.env.production` (or in `.env.development.local` to use the deployed worker from local dev) and rebuild/restart the app.

Collaborators open the room link in their own browser, so the **app** must be reachable by them too (hosted somewhere, or on your LAN — add that origin to `ALLOWED_ORIGINS`). A link like `http://localhost:3000/#room=…` only works on your machine.

## HTTP API

```
GET  /rooms/:roomId/ws                 WebSocket
GET  /rooms/:roomId/scene              → ciphertext; headers x-iv, x-scene-version, x-rev
PUT  /rooms/:roomId/scene              headers x-iv, x-scene-version, x-expected-rev
                                       → {rev} | 409 + current scene (reconcile & retry)
GET  /rooms/:roomId/files/:fileId
PUT  /rooms/:roomId/files/:fileId      (never overwrites: file ids are content hashes)
POST /shares                           body = encrypted snapshot → {id, token}
GET  /shares/:id
GET  /shares/:id/files/:fileId
PUT  /shares/:id/files/:fileId         header x-share-token, within 1h of creation
```

Limits: scene and share snapshot 25MB, file 12MB, WebSocket message 16MB. Values over 1.5MB are chunked across SQLite rows (2MB row limit).

## WebSocket protocol

Text frames are JSON control messages; binary frames carry encrypted payloads.

```
server → client  {type:"init-room", socketId}     on connect (client picks its id via ?sid=)
client → server  {type:"join-room"}
server → client  {type:"first-in-room"}           you're alone: load the scene from storage
server → others  {type:"new-user", socketId}      someone joined: send them the scene
server → all     {type:"room-user-change", clients}
client → server  {type:"user-follow", payload:{userToFollow:{socketId}, action:"FOLLOW"|"UNFOLLOW"}}
server → followed {type:"user-follow-room-change", followedBy}
client → server  "ping"  →  "pong"                (answered without waking the object)

binary  [flags u8][ivLength u8][iv][ciphertext]
        client → server flags: bit0 volatile (cursors), bit1 only to my followers
        server → client flags: 0
```
