/* Private account data is never stored in the service-worker cache. */
// Only Vite's content-hashed bundles under /assets/ and the offline page with
// its files are cached. Pages, /api/ responses and receipts always go to the network.
// A change to an OFFLINE file needs a new CACHE name, or browsers keep the old copy.
const CACHE='agentsplit-static-v7'
const OFFLINE=['/offline.html','/offline.js','/brand-mark.svg']
self.addEventListener('install',event=>{event.waitUntil(caches.open(CACHE).then(cache=>cache.addAll(OFFLINE)).then(()=>self.skipWaiting()))})
self.addEventListener('activate',event=>{event.waitUntil((async()=>{for(const key of await caches.keys())if(key!==CACHE)await caches.delete(key);await self.clients.claim()})())})
self.addEventListener('fetch',event=>{
 const request=event.request,url=new URL(request.url)
 if(request.method!=='GET'||url.origin!==self.location.origin)return
 if(request.mode==='navigate'){event.respondWith(fetch(request).catch(async()=>await caches.match('/offline.html')||Response.error()));return}
 if(OFFLINE.includes(url.pathname)){event.respondWith(fetch(request).catch(async()=>await caches.match(url.pathname)||Response.error()));return}
 if(url.pathname.startsWith('/assets/'))event.respondWith((async()=>{const cache=await caches.open(CACHE);const saved=await cache.match(request);if(saved)return saved;const response=await fetch(request);if(response.ok)await cache.put(request,response.clone());return response})())
})
self.addEventListener('message',event=>{if(event.data==='SKIP_WAITING')self.skipWaiting()})
