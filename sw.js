const STATE_CACHE = 'timer-notifier-state';
const STATE_URL = '/timer-settings.json';
const DEFAULT_STATE = { enabled: false, sound: 'default', interval: 15, lastFire: null };
const soundMap = {
  'gentle-chime': 'sounds/gentle-chime.wav',
  'digital-pulse': 'sounds/digital-pulse.wav',
  custombeep: 'sounds/custombeep.wav',
};

function normalizeState(partial) {
  const interval = Number(partial?.interval ?? DEFAULT_STATE.interval);
  const safeInterval = Number.isFinite(interval) && interval > 0 ? interval : DEFAULT_STATE.interval;
  const lastFireRaw = partial?.lastFire;
  const safeLastFire = Number.isFinite(lastFireRaw) ? Number(lastFireRaw) : null;
  return {
    ...DEFAULT_STATE,
    ...partial,
    interval: safeInterval,
    lastFire: safeLastFire,
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

function getNextTriggerTime(state) {
  const interval = getIntervalMs(state);
  const reference = state.lastFire || Date.now();
  return Math.ceil((reference + 1) / interval) * interval;
}

function nextDelay(state) {
  const nextTrigger = getNextTriggerTime(state);
  const delay = nextTrigger - Date.now();
  return Math.max(1000, delay);
}

async function registerPeriodicSync(intervalMs) {
  if (!('periodicSync' in self.registration)) {
    await notifyClients({ type: 'background-sync-status', supported: false, reason: 'unsupported' });
    return false;
  }
  if (!self.registration.active) {
    return false;
  }
  try {
    await self.registration.periodicSync.register('timer-notifier', {
      minInterval: Math.max(intervalMs, 60 * 1000),
    });
    await notifyClients({ type: 'background-sync-status', supported: true });
    return true;
  } catch (error) {
    await notifyClients({ type: 'background-sync-status', supported: false, reason: error.name });
    if (error.name !== 'NotAllowedError' && error.name !== 'NotSupportedError' && error.name !== 'InvalidStateError') {
      console.warn('Periodic sync registration failed', error);
    }
    return false;
  }
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
  await registerPeriodicSync(getIntervalMs(state));
}

async function fireNotification({ state: preloadedState, force = false, reschedule = true } = {}) {
  const state = preloadedState || (await loadState());
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
  await self.registration.showNotification('Quarter-hour reminder', options).catch((error) => {
    console.error(error);
  });
  await notifyClients({ type: 'play-sound', sound: state.sound });
  if (reschedule) {
    const updated = normalizeState({ ...state, lastFire: Date.now() });
    await saveState(updated);
    await ensureTimer();
  }
}

async function notifyClients(message) {
  const clients = await self.clients.matchAll({ includeUncontrolled: true, type: 'window' });
  await Promise.all(clients.map((client) => client.postMessage(message)));
}

self.addEventListener('periodicsync', (event) => {
  if (event.tag !== 'timer-notifier') return;
  event.waitUntil(handlePeriodicSync());
});

async function handlePeriodicSync() {
  const state = await loadState();
  if (!state.enabled) return;
  const nextTrigger = getNextTriggerTime(state);
  if (Date.now() >= nextTrigger) {
    await fireNotification({ state, force: true });
    return;
  }
  await ensureTimer();
}
