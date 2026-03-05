const DEFAULT_STATE = { enabled: false, sound: 'default', interval: 15, lastFire: null };
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
const audioContext = new (window.AudioContext || window.webkitAudioContext)();
const runtime = globalThis.browser?.runtime ?? globalThis.chrome?.runtime;
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

function updateUI() {
  toggle.checked = state.enabled;
  soundSelect.value = state.sound;
  intervalSelect.value = state.interval;
  if (!state.enabled) {
    statusEl.textContent = 'Notifications are paused.';
    return;
  }

  const next = nextReminderLabel();
  const label = state.interval === 1 ? 'minute' : 'minutes';
  statusEl.textContent = `Next alert around ${next} (every ${state.interval} ${label}).`;
}

function getIntervalMs(referenceState) {
  const minutes = referenceState?.interval ?? state.interval ?? DEFAULT_STATE.interval;
  return minutes * 60 * 1000;
}

function getNextTriggerTime(reference) {
  const intervalMs = getIntervalMs();
  const base = Number.isFinite(reference) ? reference : Date.now();
  return new Date(Math.ceil((base + 1) / intervalMs) * intervalMs);
}

function nextReminderLabel() {
  const next = getNextTriggerTime(state.lastFire);
  const hours = next.getHours().toString().padStart(2, '0');
  const minutes = next.getMinutes().toString().padStart(2, '0');
  return `${hours}:${minutes}`;
}

async function requestState() {
  if (!runtime) return;
  try {
    const response = await runtime.sendMessage({ type: 'get-state' });
    if (response?.state) {
      state = normalizeState({ ...state, ...response.state });
    } else {
      state = normalizeState(state);
    }
    updateUI();
  } catch (error) {
    console.warn('Unable to load state from background', error);
  }
}

async function sendStateUpdate() {
  state = normalizeState(state);
  updateUI();
  if (!runtime) return;
  try {
    await runtime.sendMessage({ type: 'set-state', state });
  } catch (error) {
    console.warn('Unable to update background state', error);
  }
}

function handleRuntimeMessage(message) {
  if (!message) return;
  if (message.type === 'state-updated' && message.state) {
    state = normalizeState({ ...state, ...message.state });
    updateUI();
  }
  if (message.type === 'play-sound') {
    const requestedSound = message.sound || state.sound;
    playSound(requestedSound);
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

function handleToggle() {
  state.enabled = toggle.checked;
  sendStateUpdate();
}

function handleSoundChange() {
  state.sound = soundSelect.value;
  sendStateUpdate();
}

function handleIntervalChange() {
  state.interval = Number(intervalSelect.value) || DEFAULT_STATE.interval;
  sendStateUpdate();
}

async function handleTestNotification() {
  if (!runtime) {
    statusEl.textContent = 'Extension runtime unavailable.';
    return;
  }
  statusEl.textContent = 'Sending test alert…';
  try {
    await runtime.sendMessage({ type: 'test-notification' });
    await playSound(state.sound);
    statusEl.textContent = 'Test notification triggered.';
  } catch (error) {
    console.warn('Test notification failed', error);
    statusEl.textContent = 'Unable to trigger test alert.';
  }
}

async function bootstrap() {
  populateSounds();
  populateIntervals();
  toggle.addEventListener('change', handleToggle);
  soundSelect.addEventListener('change', handleSoundChange);
  intervalSelect.addEventListener('change', handleIntervalChange);
  testButton.addEventListener('click', handleTestNotification);
  if (runtime?.onMessage?.addListener) {
    runtime.onMessage.addListener(handleRuntimeMessage);
  }
  updateUI();
  await requestState();
}

bootstrap();
