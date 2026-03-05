/* global browser */
const STATE_KEY = 'timer-notifier-state';
const ALARM_NAME = 'timer-notifier-alarm';
const DEFAULT_STATE = { enabled: false, sound: 'default', interval: 15, lastFire: null };

let state = { ...DEFAULT_STATE };

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

async function loadState() {
  try {
    const stored = await browser.storage.local.get(STATE_KEY);
    return normalizeState(stored[STATE_KEY] ?? {});
  } catch (error) {
    console.error('Unable to load stored state', error);
    return normalizeState({});
  }
}

async function saveState(newState) {
  try {
    await browser.storage.local.set({ [STATE_KEY]: newState });
  } catch (error) {
    console.error('Unable to persist state', error);
  }
}

function getIntervalMs(referenceState) {
  const minutes = referenceState?.interval ?? state.interval ?? DEFAULT_STATE.interval;
  return minutes * 60 * 1000;
}

function getNextTriggerTimeValue(referenceState) {
  const intervalMs = getIntervalMs(referenceState);
  const reference = Number.isFinite(referenceState?.lastFire) ? referenceState.lastFire : Date.now();
  return Math.ceil((reference + 1) / intervalMs) * intervalMs;
}

async function scheduleNextAlarm() {
  await browser.alarms.clear(ALARM_NAME);
  if (!state.enabled) return;
  const nextTrigger = getNextTriggerTimeValue(state);
  const when = Date.now() + Math.max(1000, nextTrigger - Date.now());
  await browser.alarms.create(ALARM_NAME, { when });
}

async function broadcastState() {
  try {
    await browser.runtime.sendMessage({ type: 'state-updated', state });
  } catch (error) {
    // ignore; no pages are listening
  }
}

async function requestSoundPlayback() {
  try {
    await browser.runtime.sendMessage({ type: 'play-sound', sound: state.sound });
  } catch (error) {
    // pages might not be open; nothing to do
  }
}

async function fireNotification({ force = false, reschedule = true, updateTimestamp = true } = {}) {
  if (!state.enabled && !force) return;
  const now = new Date();
  const hours = now.getHours().toString().padStart(2, '0');
  const minutes = now.getMinutes().toString().padStart(2, '0');
  const body = `Current time ${hours}:${minutes}`;
  const iconUrl = browser.runtime.getURL('icons/icon-128.png');
  try {
    await browser.notifications.create('timer-notifier', {
      title: 'Quarter-hour reminder',
      body,
      tag: 'quarter-hour-alert',
      renotify: true,
      iconUrl,
    });
  } catch (error) {
    console.error('Unable to show notification', error);
  }
  requestSoundPlayback();
  if (updateTimestamp) {
    state = normalizeState({ ...state, lastFire: Date.now() });
    await saveState(state);
    await broadcastState();
  }
  if (reschedule) {
    await scheduleNextAlarm();
  }
}

browser.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== ALARM_NAME) return;
  return fireNotification();
});

browser.notifications.onClicked.addListener(async () => {
  const url = browser.runtime.getURL('index.html');
  try {
    await browser.tabs.create({ url });
  } catch (error) {
    console.error('Unable to open settings', error);
  }
});

browser.runtime.onMessage.addListener((message) => {
  if (!message?.type) return undefined;
  if (message.type === 'get-state') {
    return Promise.resolve({ state });
  }
  if (message.type === 'set-state') {
    state = normalizeState({ ...state, ...message.state });
    return saveState(state)
      .then(() => scheduleNextAlarm())
      .then(() => broadcastState())
      .then(() => ({ state }))
      .catch((error) => {
        console.error('Unable to sync state update', error);
        return { state };
      });
  }
  if (message.type === 'test-notification') {
    return fireNotification({ force: true, reschedule: false, updateTimestamp: false });
  }
  return undefined;
});

async function initialize() {
  const stored = await loadState();
  state = normalizeState({ ...state, ...stored });
  await broadcastState();
  await scheduleNextAlarm();
}

browser.runtime.onInstalled.addListener(() => {
  initialize();
});

browser.runtime.onStartup.addListener(() => {
  initialize();
});

initialize();
