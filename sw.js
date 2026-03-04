const STATE_CACHE = 'timer-notifier-state';
const STATE_URL = '/timer-settings.json';
const DEFAULT_STATE = { enabled: false, sound: 'default', interval: 15 };
const soundMap = {
  'gentle-chime': 'sounds/gentle-chime.wav',
  'digital-pulse': 'sounds/digital-pulse.wav',
  custombeep: 'sounds/custombeep.wav',
};

function normalizeState(partial) {
  const interval = Number(partial?.interval ?? DEFAULT_STATE.interval);
  const safeInterval = Number.isFinite(interval) && interval > 0 ? interval : DEFAULT_STATE.interval;
  return {
    ...DEFAULT_STATE,
    ...partial,
    interval: safeInterval,
  };
}

let timerId = null;

self.addEventListener('install', (event) => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      await self.clients.claim();
      await ensureTimer();
    })(),
  );
});

self.addEventListener('message', (event) => {
  if (!event.data) return;
  if (event.data.type === 'update') {
    const incoming = normalizeState(event.data.state || {});
    event.waitUntil(
      (async () => {
        await saveState(incoming);
        await ensureTimer();
        await broadcastState(incoming);
      })(),
    );
    return;
  }
  if (event.data.type === 'test') {
    event.waitUntil(
      (async () => {
        await fireNotification({ force: true, reschedule: false });
      })(),
    );
  }
});

async function broadcastState(state) {
  const allClients = await self.clients.matchAll({ includeUncontrolled: true, type: 'window' });
  await Promise.all(allClients.map((client) => client.postMessage({ type: 'state', state })));
}

async function saveState(state) {
  const cache = await caches.open(STATE_CACHE);
  const normalized = normalizeState(state);
  await cache.put(STATE_URL, new Response(JSON.stringify(normalized)));
}

async function loadState() {
  try {
    const cache = await caches.open(STATE_CACHE);
    const response = await cache.match(STATE_URL);
    if (!response) return normalizeState({});
    const parsed = await response.json();
    return normalizeState(parsed);
  } catch (error) {
    return normalizeState({});
  }
}

function clearTimer() {
  if (timerId) {
    clearTimeout(timerId);
    timerId = null;
  }
}

function getIntervalMs(state) {
  return (state.interval || DEFAULT_STATE.interval) * 60 * 1000;
}

function nextDelay(state) {
  const interval = getIntervalMs(state);
  const now = Date.now();
  const nextTick = Math.ceil((now + 1) / interval) * interval;
  const delay = nextTick - now;
  return Math.max(1000, delay);
}

async function ensureTimer() {
  clearTimer();
  const state = await loadState();
  await broadcastState(state);
  if (!state.enabled) return;
  const delay = nextDelay(state);
  timerId = setTimeout(() => {
    fireNotification();
  }, delay);
}

async function fireNotification({ force = false, reschedule = true } = {}) {
  const state = await loadState();
  if (!state.enabled && !force) return;
  const now = new Date();
  const hours = now.getHours().toString().padStart(2, '0');
  const minutes = now.getMinutes().toString().padStart(2, '0');
  const body = `Current time ${hours}:${minutes}`;
  const options = {
    body,
    tag: 'quarter-hour-alert',
    renotify: true,
    data: { sound: state.sound },
  };
  if (soundMap[state.sound]) {
    options.sound = soundMap[state.sound];
  }
  await self.registration.showNotification('Quarter-hour reminder', options).catch(() => {});
  await notifyClients({ type: 'play-sound', sound: state.sound });
  if (reschedule) {
    await ensureTimer();
  }
}

async function notifyClients(message) {
  const clients = await self.clients.matchAll({ includeUncontrolled: true, type: 'window' });
  await Promise.all(clients.map((client) => client.postMessage(message)));
}
