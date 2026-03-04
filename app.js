const STATE_KEY = 'timer-notifier-settings';
const DEFAULT_STATE = { enabled: false, sound: 'default', interval: 15, lastFire: null, pageVisible: false };
const soundOptions = [
  { value: 'default', label: 'Browser default (system sound)' },
  { value: 'gentle-chime', label: 'Gentle chime' },
  { value: 'digital-pulse', label: 'Digital pulse' },
  { value: 'custombeep', label: 'Custom beep (replace with your own file later)' },
];

const soundFiles = {
  // 'gentle-chime': 'sounds/gentle-chime.wav',
  // 'digital-pulse': 'sounds/digital-pulse.wav',
  // custombeep: 'sounds/custombeep.wav',
};

const intervalOptions = [1, 2, 5, 10, 15, 30, 60];

const toggle = document.getElementById('notify-toggle');
const soundSelect = document.getElementById('sound-select');
const intervalSelect = document.getElementById('interval-select');
const testButton = document.getElementById('test-notification');
const statusEl = document.getElementById('status');
let pageTimerId = null;
const backgroundSupportEl = document.getElementById('background-support');
const audioContext = new (window.AudioContext || window.webkitAudioContext)();
let state = { ...DEFAULT_STATE };

function normalizeState(partial) {
  const interval = Number(partial?.interval ?? DEFAULT_STATE.interval);
  const safeInterval = Number.isFinite(interval) && interval > 0 ? interval : DEFAULT_STATE.interval;
  const lastFireRaw = partial?.lastFire;
  const safeLastFire = Number.isFinite(lastFireRaw) ? Number(lastFireRaw) : null;
  const pageVisibleRaw = partial?.pageVisible;
  const safePageVisible = pageVisibleRaw === true;
  return {
    ...DEFAULT_STATE,
    ...partial,
    interval: safeInterval,
    lastFire: safeLastFire,
    pageVisible: safePageVisible,
  };
}

function loadState() {
  const saved = localStorage.getItem(STATE_KEY);
  if (!saved) return;
  try {
    const parsed = JSON.parse(saved);
    state = normalizeState(parsed);
  } catch (error) {
    console.warn('Invalid saved state', error);
  }
}

function saveState() {
  state = normalizeState(state);
  localStorage.setItem(STATE_KEY, JSON.stringify(state));
}

function updateUI() {
  toggle.checked = state.enabled;
  soundSelect.value = state.sound;
  intervalSelect.value = state.interval;
  if (!state.enabled) {
    statusEl.textContent = 'Notifications are paused.';
    return;
  }

  if (Notification.permission === 'granted') {
    const next = nextQuarterLabel(state.interval);
    const label = state.interval === 1 ? 'minute' : 'minutes';
    statusEl.textContent = `Next alert around ${next} (every ${state.interval} ${label}).`;
    return;
  }

  statusEl.textContent = 'Awaiting notification permission…';
}

function getPageIntervalMs() {
  const minutes = state.interval || DEFAULT_STATE.interval;
  return minutes * 60 * 1000;
}

function getNextPageTrigger(referenceTime = state.lastFire) {
  const intervalMs = getPageIntervalMs();
  const base = referenceTime || Date.now();
  return Math.ceil((base + 1) / intervalMs) * intervalMs;
}

function stopPageTimer() {
  if (!pageTimerId) return;
  clearTimeout(pageTimerId);
  pageTimerId = null;
}

function schedulePageTimer() {
  stopPageTimer();
  if (!state.enabled || !state.pageVisible) return;
  const nextTrigger = getNextPageTrigger();
  const delay = Math.max(1000, nextTrigger - Date.now());
  pageTimerId = setTimeout(async () => {
    await triggerPageNotification();
  }, delay);
}

async function triggerPageNotification({ force = false } = {}) {
  if (!state.enabled && !force) return;
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  const now = new Date();
  const hours = now.getHours().toString().padStart(2, '0');
  const minutes = now.getMinutes().toString().padStart(2, '0');
  const body = `Current time ${hours}:${minutes}`;
  try {
    new Notification('Quarter-hour reminder', {
      body,
      tag: 'quarter-hour-alert',
      renotify: true,
    });
  } catch (error) {
    console.warn('Page notification failed', error);
  }
  await playSound(state.sound);
  state.lastFire = Date.now();
  saveState();
  await notifyWorker();
  schedulePageTimer();
}

function nextQuarterLabel(intervalMinutes) {
  const now = new Date();
  const roundedMinutes = intervalMinutes || DEFAULT_STATE.interval;
  const interval = roundedMinutes * 60 * 1000;
  const next = new Date(Math.ceil((now.getTime() + 1) / interval) * interval);
  const hours = next.getHours().toString().padStart(2, '0');
  const minutes = next.getMinutes().toString().padStart(2, '0');
  return `${hours}:${minutes}`;
}

async function ensureNotificationPermission() {
  if (!('Notification' in window)) {
    statusEl.textContent = 'Notifications are unavailable in this browser.';
    return false;
  }

  if (Notification.permission === 'granted') return true;
  if (Notification.permission === 'denied') {
    statusEl.textContent = 'Notifications were blocked. Please update browser permissions.';
    return false;
  }

  const permission = await Notification.requestPermission();
  return permission === 'granted';
}

async function postToServiceWorker(message) {
  if (!('serviceWorker' in navigator)) return;
  try {
    const registration = await navigator.serviceWorker.ready;
    const worker = navigator.serviceWorker.controller || registration.active || registration.waiting || registration.installing;
    worker?.postMessage(message);
  } catch (error) {
    console.warn('Unable to reach service worker', error);
  }
}

async function notifyWorker() {
  await postToServiceWorker({ type: 'update', state });
}

function populateSounds() {
  soundOptions.forEach(({ value, label }) => {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = label;
    soundSelect.append(option);
  });
}

function populateIntervals() {
  intervalOptions.forEach((minutes) => {
    const option = document.createElement('option');
    option.value = minutes.toString();
    option.textContent = minutes === 1 ? 'Every 1 minute' : `Every ${minutes} minutes`;
    intervalSelect.append(option);
  });
}

async function playSynth(soundKey) {
  if (!audioContext) return;
  if (audioContext.state === 'suspended') {
    try {
      await audioContext.resume();
    } catch (error) {
      console.warn('Unable to resume audio context', error);
    }
  }

  const osc = audioContext.createOscillator();
  const gain = audioContext.createGain();
  osc.connect(gain);
  gain.connect(audioContext.destination);

  const variants = {
    'gentle-chime': { frequency: 640, duration: 0.28 },
    'digital-pulse': { frequency: 940, duration: 0.16 },
    custombeep: { frequency: 520, duration: 0.34, type: 'triangle' },
  };

  const config = variants[soundKey] || { frequency: 660, duration: 0.2 };
  osc.type = config.type || 'sine';
  osc.frequency.value = config.frequency;
  gain.gain.setValueAtTime(0.4, audioContext.currentTime);
  osc.start();
  gain.gain.exponentialRampToValueAtTime(0.001, audioContext.currentTime + config.duration);
  osc.stop(audioContext.currentTime + config.duration);
}

async function playSound(soundKey) {
  if (soundKey === 'default') return;
  const url = soundFiles[soundKey];
  if (url) {
    try {
      const audio = new Audio(url);
      await audio.play();
      return;
    } catch (error) {
      console.warn('Sound file failed to play', error);
    }
  }
  await playSynth(soundKey);
}

function handleWorkerMessages(event) {
  if (!event.data) return;
  if (event.data.type === 'background-sync-status') {
    applyBackgroundSyncStatus(event.data);
    return;
  }
  if (event.data.type === 'play-sound') {
    const requestedSound = event.data.sound || state.sound;
    playSound(requestedSound);
  }
  if (event.data.type === 'state') {
    state = normalizeState({ ...state, ...event.data.state });
    saveState();
    updateUI();
  }
}

async function initServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  navigator.serviceWorker.addEventListener('message', handleWorkerMessages);
  navigator.serviceWorker.addEventListener('controllerchange', () => notifyWorker());
  try {
    const registration = await navigator.serviceWorker.register('sw.js');
    registration.active && notifyWorker();
    navigator.serviceWorker.ready.then(() => notifyWorker());
    return registration;
  } catch (error) {
    console.warn('Service worker registration failed', error);
  }
}

async function handleToggle() {
  if (toggle.checked) {
    const permissionGranted = await ensureNotificationPermission();
    if (!permissionGranted) {
      toggle.checked = false;
      state.enabled = false;
      saveState();
      updateUI();
      return;
    }
  }
  state.enabled = toggle.checked;
  saveState();
  updateUI();
  notifyWorker();
  schedulePageTimer();
}

function handleSoundChange() {
  state.sound = soundSelect.value;
  saveState();
  notifyWorker();
}

function handleIntervalChange() {
  state.interval = Number(intervalSelect.value) || DEFAULT_STATE.interval;
  saveState();
  notifyWorker();
  schedulePageTimer();
}

async function handleTestNotification() {
  const permissionGranted = await ensureNotificationPermission();
  if (!permissionGranted) return;
  if (!('serviceWorker' in navigator)) {
    statusEl.textContent = 'Service worker is unavailable in this browser.';
    return;
  }
  statusEl.textContent = 'Requesting a test notification…';
  try {
    await postToServiceWorker({ type: 'test' });
    statusEl.textContent = 'Test notification triggered (check your system tray).';
  } catch (error) {
    console.warn('Unable to reach service worker for testing', error);
    statusEl.textContent = 'Unable to trigger test alert.';
  }
}

async function describeBackgroundSupport() {
  if (!backgroundSupportEl) return;
  if (!('serviceWorker' in navigator)) {
    backgroundSupportEl.textContent = 'Service workers are unavailable in this browser.';
    return;
  }
  backgroundSupportEl.textContent = 'Checking background availability…';
  try {
    const registration = await navigator.serviceWorker.ready;
    if (!('periodicSync' in registration)) {
      backgroundSupportEl.textContent = 'Periodic Background Sync is not supported here, so alerts only fire while this tab stays open.';
      return;
    }
    if (!('permissions' in navigator)) {
      backgroundSupportEl.textContent = 'Periodic Background Sync exists; enable it in your browser settings for closed-tab alerts.';
      return;
    }
    const status = await navigator.permissions.query({ name: 'periodic-background-sync' });
    if (status.state === 'denied') {
      backgroundSupportEl.textContent = 'Enable Periodic Background Sync in the site settings to keep alerts running after closing the tab.';
    } else if (status.state === 'granted') {
      backgroundSupportEl.textContent = 'Periodic Background Sync is enabled; notifications stay active when the tab is closed.';
    } else {
      backgroundSupportEl.textContent = 'Periodic Background Sync is available; allow it in the browser settings for offline alerts.';
    }
  } catch (error) {
    backgroundSupportEl.textContent = 'Background sync support could not be determined; notifications work while this tab is open.';
  }
}

function handleVisibilityChange() {
  const visible = document.visibilityState === 'visible';
  if (state.pageVisible === visible) return;
  state.pageVisible = visible;
  saveState();
  notifyWorker();
  if (visible) {
    schedulePageTimer();
  } else {
    stopPageTimer();
  }
}

function applyBackgroundSyncStatus({ supported, reason }) {
  if (!backgroundSupportEl) return;
  if (supported) {
    backgroundSupportEl.textContent = 'Periodic Background Sync is active; alerts keep running when the tab is closed.';
    return;
  }
  if (reason === 'unsupported' || reason === 'NotSupportedError') {
    backgroundSupportEl.textContent = 'Periodic Background Sync is not available; notifications stop once the tab closes.';
    return;
  }
  if (reason === 'NotAllowedError') {
    backgroundSupportEl.textContent = 'Allow Periodic Background Sync in your site settings to keep notifications alive offline.';
    return;
  }
  backgroundSupportEl.textContent = 'Background sync could not register; check your browser permissions to keep alerts running when the tab is closed.';
}

async function bootstrap() {
  populateSounds();
  populateIntervals();
  loadState();
  updateUI();
  toggle.addEventListener('change', handleToggle);
  soundSelect.addEventListener('change', handleSoundChange);
  intervalSelect.addEventListener('change', handleIntervalChange);
  testButton.addEventListener('click', handleTestNotification);
  document.addEventListener('visibilitychange', handleVisibilityChange);
  handleVisibilityChange();
  await initServiceWorker();
  await describeBackgroundSupport();
}

bootstrap();
