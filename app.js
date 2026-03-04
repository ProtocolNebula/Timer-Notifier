const STATE_KEY = 'timer-notifier-settings';
const DEFAULT_STATE = { enabled: false, sound: 'default', interval: 15 };
const soundOptions = [
  { value: 'default', label: 'Browser default (system sound)' },
  { value: 'gentle-chime', label: 'Gentle chime' },
  { value: 'digital-pulse', label: 'Digital pulse' },
  { value: 'custombeep', label: 'Custom beep (replace with your own file later)' },
];

const soundFiles = {
  'gentle-chime': 'sounds/gentle-chime.wav',
  'digital-pulse': 'sounds/digital-pulse.wav',
  custombeep: 'sounds/custombeep.wav',
};

const intervalOptions = [1, 2, 5, 10, 15, 30, 60];

const toggle = document.getElementById('notify-toggle');
const soundSelect = document.getElementById('sound-select');
const intervalSelect = document.getElementById('interval-select');
const testButton = document.getElementById('test-notification');
const statusEl = document.getElementById('status');
const audioContext = new (window.AudioContext || window.webkitAudioContext)();
let state = { ...DEFAULT_STATE };

function normalizeState(partial) {
  const interval = Number(partial?.interval ?? DEFAULT_STATE.interval);
  const safeInterval = Number.isFinite(interval) && interval > 0 ? interval : DEFAULT_STATE.interval;
  return {
    ...DEFAULT_STATE,
    ...partial,
    interval: safeInterval,
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

async function notifyWorker() {
  if (!('serviceWorker' in navigator)) return;
  try {
    const registration = await navigator.serviceWorker.ready;
    const controller = navigator.serviceWorker.controller || registration.active || registration.waiting || registration.installing;
    controller?.postMessage({ type: 'update', state });
  } catch (error) {
    console.warn('Unable to notify service worker', error);
  }
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
  try {
    const registration = await navigator.serviceWorker.register('sw.js');
    registration.active && notifyWorker();
    navigator.serviceWorker.ready.then(() => notifyWorker());
  } catch (error) {
    console.warn('Service worker registration failed', error);
  }
  navigator.serviceWorker.addEventListener('message', handleWorkerMessages);
  navigator.serviceWorker.addEventListener('controllerchange', () => notifyWorker());
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
    const registration = await navigator.serviceWorker.ready;
    const controller = navigator.serviceWorker.controller || registration.active || registration.waiting || registration.installing;
    controller?.postMessage({ type: 'test' });
    statusEl.textContent = 'Test notification triggered (check your system tray).';
  } catch (error) {
    console.warn('Unable to reach service worker for testing', error);
    statusEl.textContent = 'Unable to trigger test alert.';
  }
}

function bootstrap() {
  populateSounds();
  populateIntervals();
  loadState();
  updateUI();
  toggle.addEventListener('change', handleToggle);
  soundSelect.addEventListener('change', handleSoundChange);
  intervalSelect.addEventListener('change', handleIntervalChange);
  testButton.addEventListener('click', handleTestNotification);
  initServiceWorker();
}

bootstrap();
