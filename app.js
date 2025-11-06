// CrowdPlay - Main Application
console.log('CrowdPlay initialized!');

// ============================================================================
// CONFIGURATION
// ============================================================================

// Firebase configuration
// Regional database (europe-west1) URL from Firebase Console
const firebaseConfig = {
  apiKey: "AIzaSyAh0Dh_TE0r3PYahE9B86Jo3vui1QW96rU",
  authDomain: "crowdplay-2025.firebaseapp.com",
  databaseURL: "https://crowdplay-2025-default-rtdb.europe-west1.firebasedatabase.app",
  projectId: "crowdplay-2025",
  storageBucket: "crowdplay-2025.firebasestorage.app",
  messagingSenderId: "470091878545",
  appId: "1:470091878545:web:0059ece92aea7cb91bef30"
};

// ============================================================================
// UTILITY FUNCTIONS
// ============================================================================

// Parse URL parameters
function getURLParams() {
    const params = new URLSearchParams(window.location.search);
    return {
        conduct: params.has('conduct'),
        project: params.has('project'),
        room: params.get('room')
    };
}

// Generate random room ID
function generateRoomID() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // Removed ambiguous chars
    let result = '';
    for (let i = 0; i < 6; i++) {
        result += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return result;
}

// Show specific view
function showView(viewId) {
    document.querySelectorAll('.view').forEach(view => {
        view.style.display = 'none';
    });
    document.getElementById(viewId).style.display = 'block';
}

// Status indicator management
function setStatus(type, message = '') {
    const indicator = document.getElementById('status-indicator');
    if (!indicator) return;

    // Remove all status classes
    indicator.className = '';
    indicator.textContent = '';

    if (type === 'connected') {
        indicator.className = 'status-dot';
        indicator.title = 'Connected';
    } else if (type === 'error') {
        indicator.className = 'status-error';
        indicator.textContent = message || 'Connection Error';
        indicator.title = message;
    } else if (type === 'warning') {
        indicator.className = 'status-warning';
        indicator.textContent = message || 'Warning';
        indicator.title = message;
    }
}

// Monitor Firebase connection
function monitorConnection() {
    if (!db) return;

    const connectedRef = db.ref('.info/connected');
    connectedRef.on('value', (snapshot) => {
        if (snapshot.val() === true) {
            console.log('✓ Firebase connected');
            updateSyncStatus();
        } else {
            console.warn('✗ Firebase disconnected');
            setStatus('error', 'Disconnected');
            isSynced = false;
        }
    });
}

// Monitor Firebase server time offset and sync local clock
function monitorServerTime() {
    if (!db) return;

    const offsetRef = db.ref('.info/serverTimeOffset');

    // Function to process a time offset sample
    const processSample = (firebaseOffset) => {
        if (syncSampleCount === 0) {
            // First sample: just set it directly
            serverTimeOffset = firebaseOffset;
            console.log('Initial server time offset:', serverTimeOffset, 'ms');
        } else {
            // Subsequent samples: apply first-order filter
            const oldOffset = serverTimeOffset;
            serverTimeOffset = SYNC_FILTER_K * serverTimeOffset + (1 - SYNC_FILTER_K) * firebaseOffset;
            console.log(`Time sync sample ${syncSampleCount + 1}: ${firebaseOffset}ms (filtered: ${Math.round(serverTimeOffset)}ms, prev: ${Math.round(oldOffset)}ms)`);
        }

        syncSampleCount++;

        // Check if we've achieved sync
        if (syncSampleCount >= SYNC_SAMPLES_NEEDED && !isSynced) {
            isSynced = true;
            console.log('✓ Time synchronized! Final offset:', Math.round(serverTimeOffset), 'ms');
        }

        updateSyncStatus();
    };

    // Take initial samples rapidly to converge quickly
    let initialSamplesTaken = 0;
    const takeSample = () => {
        offsetRef.once('value', (snapshot) => {
            processSample(snapshot.val());
            initialSamplesTaken++;

            // Take more samples if we haven't reached the target
            if (initialSamplesTaken < SYNC_SAMPLES_NEEDED) {
                setTimeout(takeSample, 200); // Wait 200ms between samples
            }
        });
    };

    // Start taking samples
    takeSample();

    // Also listen for changes (in case Firebase detects drift)
    offsetRef.on('value', (snapshot) => {
        // Only process if we're already synced (this catches drift updates)
        if (isSynced) {
            const firebaseOffset = snapshot.val();
            const oldOffset = serverTimeOffset;
            serverTimeOffset = SYNC_FILTER_K * serverTimeOffset + (1 - SYNC_FILTER_K) * firebaseOffset;

            // Only log if offset changed significantly (>5ms)
            if (Math.abs(firebaseOffset - oldOffset) > 5) {
                console.log(`Time drift detected: ${firebaseOffset}ms (filtered: ${Math.round(serverTimeOffset)}ms)`);
            }
        }
    });
}

// Get current synchronized time (in milliseconds)
function getSyncedTime() {
    return Date.now() + serverTimeOffset;
}

// Update status indicator based on connection and sync state
function updateSyncStatus() {
    if (!isSynced) {
        setStatus('warning', `Syncing time... (${syncSampleCount}/${SYNC_SAMPLES_NEEDED})`);
    } else if (mode === 'participant' && !audioFilesLoaded) {
        setStatus('warning', `Loading audio... (${audioLoadProgress.loaded}/${audioLoadProgress.total})`);
    } else {
        setStatus('connected');
    }
}

// ============================================================================
// MODE DETECTION AND INITIALIZATION
// ============================================================================

let mode = 'landing';
let roomId = null;
let db = null;

// Time synchronization state
let serverTimeOffset = 0;        // Our offset from Firebase server time (ms)
let isSynced = false;            // Whether we have achieved sync
let syncSampleCount = 0;         // Number of sync samples received
const SYNC_SAMPLES_NEEDED = 5;   // Take 5 samples for better accuracy
const SYNC_FILTER_K = 0.6;       // Filter constant: 0.6 = reasonably fast convergence

// Latency tracking (Conductor only)
let clientLatencies = new Map();  // clientId -> {latency, lastSeen}
const MAX_LATENCY_MS = 5000;      // Ignore latencies > 5s
const LATENCY_PROBE_INTERVAL = 10000;  // Send probes every 10s

// Participant ID and name (Participant only)
let participantId = null;
let participantName = null;
let wakeLock = null;  // Screen wake lock

// Audio playback state (using Web Audio API)
let audioContext = null;  // Web Audio API context
let audioBuffers = new Map();  // filename -> AudioBuffer (decoded audio data)
let currentSource = null;  // Currently playing AudioBufferSourceNode
let audioFilesLoaded = false;  // Whether all audio files have been preloaded
let audioLoadProgress = { loaded: 0, total: 0 };  // Track loading progress

// Flash state (for time sync testing)
let flashIntervalId = null;  // Interval for repeating flashes
let flashStartTime = null;  // Synced time when flashes should start
let flashInterval = 3000;  // Time between flashes in ms

// Drum hit detection (Participant only)
let lastDrumHitTime = 0;  // Last time we sent a drum hit event
const DRUM_THROTTLE_MS = 500;  // Minimum time between drum hits (0.5s)
const DRUM_THRESHOLD = 20;  // Acceleration threshold for drum hit detection

document.addEventListener('DOMContentLoaded', () => {
    console.log('Page loaded and ready!');

    const params = getURLParams();

    // Determine mode
    if (params.conduct) {
        mode = 'conductor';
        initConductor();
    } else if (params.project && params.room) {
        mode = 'projector';
        roomId = params.room;
        initProjector();
    } else if (params.room) {
        mode = 'participant';
        roomId = params.room;
        initParticipant();
    } else {
        mode = 'landing';
        showView('landing-view');
        setStatus('warning', 'Add ?conduct or ?room=XXX to URL');
    }
});

// ============================================================================
// CONDUCTOR MODE
// ============================================================================

function initConductor() {
    console.log('Initializing conductor mode...');
    showView('conductor-view');

    // Check for saved room ID in localStorage, otherwise generate new one
    const savedRoomId = localStorage.getItem('crowdplay-roomId');
    if (savedRoomId) {
        roomId = savedRoomId;
        console.log('Reusing saved room ID:', roomId);
    } else {
        roomId = generateRoomID();
        localStorage.setItem('crowdplay-roomId', roomId);
        console.log('Generated new room ID:', roomId);
    }

    document.getElementById('room-id').textContent = roomId;

    // Generate QR code
    const roomURL = window.location.origin + window.location.pathname + '?room=' + roomId;
    new QRCode(document.getElementById('qr-code'), {
        text: roomURL,
        width: 256,
        height: 256
    });

    console.log('Room URL:', roomURL);

    // Initialize Firebase
    initFirebase();

    // Set up keyboard controls
    setupConductorKeyboard();

    // Listen for participants
    listenForParticipants();

    // Start periodic state broadcasts (for latency probes and state sync)
    startPeriodicStateBroadcast();

    // Listen for client heartbeats
    listenForHeartbeats();
}

function setupConductorKeyboard() {
    document.addEventListener('keydown', (e) => {
        const key = e.key.toLowerCase();

        if (key === 'b') {
            console.log('Sending BLACK command');
            sendCommand({ type: 'color', value: 'black' });
        } else if (key === 'w') {
            console.log('Sending WHITE command');
            sendCommand({ type: 'color', value: 'white' });
        } else if (key === 'c' || key === 'p') {
            console.log('Triggering audio playback');
            triggerAudioPlayback();
        } else if (key === 's') {
            console.log('Stopping audio');
            sendCommand({ type: 'stopAudio' });
        } else if (key === 'm') {
            console.log('Triggering music playback');
            triggerMusicPlayback();
        } else if (key === 'f') {
            console.log('Triggering synchronized flash');
            triggerFlash();
        }
    });
}

// Trigger synchronized audio playback on all clients
function triggerAudioPlayback() {
    if (!isSynced) {
        console.error('Cannot trigger audio: not yet time-synced');
        return;
    }

    // Calculate start time: current time + 2x the 95th percentile latency (safety buffer)
    const latency95th = calculate95thPercentileLatency();
    const buffer = Math.max(latency95th * 2, 500);  // Minimum 500ms buffer
    const startTime = getSyncedTime() + buffer;

    console.log(`Scheduling audio to start in ${Math.round(buffer)}ms (latency 95th: ${Math.round(latency95th)}ms)`);

    sendCommand({
        type: 'playAudio',
        file: 'samples/clap.mp3',
        startTime: startTime,
        loop: true
    });
}

// Trigger synchronized music playback on all clients (no loop)
function triggerMusicPlayback() {
    if (!isSynced) {
        console.error('Cannot trigger music: not yet time-synced');
        return;
    }

    // Calculate start time: current time + 2x the 95th percentile latency (safety buffer)
    const latency95th = calculate95thPercentileLatency();
    const buffer = Math.max(latency95th * 2, 500);  // Minimum 500ms buffer
    const startTime = getSyncedTime() + buffer;

    console.log(`Scheduling music to start in ${Math.round(buffer)}ms (latency 95th: ${Math.round(latency95th)}ms)`);

    sendCommand({
        type: 'playAudio',
        file: 'samples/sandstorm.mp3',
        startTime: startTime,
        loop: false
    });
}

// Trigger synchronized flash on all clients
function triggerFlash() {
    if (!isSynced) {
        console.error('Cannot trigger flash: not yet time-synced');
        return;
    }

    // Calculate start time: current time + 2x the 95th percentile latency (safety buffer)
    const latency95th = calculate95thPercentileLatency();
    const buffer = Math.max(latency95th * 2, 500);  // Minimum 500ms buffer
    const startTime = getSyncedTime() + buffer;

    console.log(`Scheduling flash to start in ${Math.round(buffer)}ms, repeating every 3000ms`);

    sendCommand({
        type: 'flash',
        startTime: startTime,
        interval: 3000  // Flash every 3 seconds
    });
}

function sendCommand(command) {
    if (!db || !roomId) {
        console.error('Firebase not initialized or no room ID');
        return;
    }

    const commandRef = db.ref(`rooms/${roomId}/toClients`).push();
    commandRef.set({
        ...command,
        timestamp: getSyncedTime()  // Use synced time for accurate latency measurement
    });
}

function listenForParticipants() {
    if (!db || !roomId) {
        console.error('Firebase not initialized or no room ID');
        return;
    }

    const participantsRef = db.ref(`rooms/${roomId}/participants`);

    participantsRef.on('value', (snapshot) => {
        const count = snapshot.numChildren();
        document.getElementById('participant-count').textContent = count;
        console.log('Participant count:', count);
    });
}

// Start periodic state broadcasts (includes latency probe)
function startPeriodicStateBroadcast() {
    if (!db || !roomId) {
        console.error('Firebase not initialized or no room ID');
        return;
    }

    // Send initial state immediately
    sendStateUpdate();

    // Then send every 10 seconds
    setInterval(() => {
        sendStateUpdate();
    }, LATENCY_PROBE_INTERVAL);
}

function sendStateUpdate() {
    sendCommand({
        type: 'state',
        // Add game state here as we build it out
        // For now, just used for latency probe (timestamp is added by sendCommand)
    });
}

// Listen for heartbeat and drum hit messages from clients
function listenForHeartbeats() {
    if (!db || !roomId) {
        console.error('Firebase not initialized or no room ID');
        return;
    }

    const heartbeatRef = db.ref(`rooms/${roomId}/toController`);

    heartbeatRef.on('child_added', (snapshot) => {
        const message = snapshot.val();

        if (message.type === 'heartbeat') {
            const clientId = message.clientId;
            const latency = message.latency;
            const name = message.name || 'Unknown';

            // Update latency tracking
            if (latency < MAX_LATENCY_MS) {
                clientLatencies.set(clientId, {
                    name: name,
                    latency: latency,
                    lastSeen: Date.now()
                });
            }

            // Clean up old/slow clients (not seen in 30s)
            const now = Date.now();
            for (const [id, data] of clientLatencies.entries()) {
                if (now - data.lastSeen > 30000) {
                    clientLatencies.delete(id);
                }
            }

            // Update display
            updateLatencyDisplay();

            // Remove the heartbeat message to keep database clean
            snapshot.ref.remove();
        } else if (message.type === 'drumHit') {
            // Participant detected a drum hit - broadcast to all clients
            console.log(`Drum hit from ${message.name}, magnitude: ${message.magnitude}`);

            // Broadcast drum hit command to projector and all participants
            sendCommand({ type: 'drumHit' });

            // Remove the drum hit message to keep database clean
            snapshot.ref.remove();
        }
    });
}

// Calculate 95th percentile latency from all clients
function calculate95thPercentileLatency() {
    if (clientLatencies.size === 0) return 0;

    const latencies = Array.from(clientLatencies.values())
        .map(data => data.latency)
        .sort((a, b) => a - b);

    const index = Math.ceil(latencies.length * 0.95) - 1;
    return latencies[Math.max(0, index)];
}

// Update the latency display in conductor UI
function updateLatencyDisplay() {
    const latency95th = calculate95thPercentileLatency();
    document.getElementById('latency-95th').textContent = latency95th > 0 ? `${Math.round(latency95th)}ms` : '--';

    // Update per-client latency list
    const listEl = document.getElementById('client-latencies');
    if (!listEl) return;

    if (clientLatencies.size === 0) {
        listEl.innerHTML = '<p style="opacity: 0.6;">No latency data yet</p>';
        return;
    }

    // Sort by latency (worst first)
    const sortedClients = Array.from(clientLatencies.entries())
        .sort((a, b) => b[1].latency - a[1].latency);

    listEl.innerHTML = sortedClients.map(([clientId, data]) => {
        const displayName = data.name || 'Unknown';
        const latency = Math.round(data.latency);

        // Color code: <200ms green, <500ms yellow, >500ms red
        let colorClass = 'latency-good';
        if (latency > 500) colorClass = 'latency-bad';
        else if (latency > 200) colorClass = 'latency-ok';

        return `<div class="latency-item"><span>${displayName}</span><span class="${colorClass}">${latency}ms</span></div>`;
    }).join('');
}

// ============================================================================
// PROJECTOR MODE
// ============================================================================

function initProjector() {
    console.log('Initializing projector mode for room:', roomId);
    showView('projector-view');

    // Start preloading audio files immediately
    preloadAudioFiles();

    // Initialize Firebase
    initFirebase();

    // Listen for commands from conductor
    listenForProjectorCommands();

    // Listen for participant count
    listenForProjectorParticipants();

    // Update status
    document.getElementById('projector-status').textContent = 'Connected to room ' + roomId;
}

function listenForProjectorCommands() {
    if (!db || !roomId) {
        console.error('Firebase not initialized or no room ID');
        return;
    }

    const commandsRef = db.ref(`rooms/${roomId}/toClients`);

    // Only listen to commands created AFTER we connect (ignore backlog)
    const joinTime = Date.now();
    console.log('Listening for commands created after:', joinTime);

    commandsRef.orderByChild('timestamp').startAt(joinTime).on('child_added', (snapshot) => {
        const command = snapshot.val();
        console.log('Received command:', command);

        handleProjectorCommand(command);
    });
}

function handleProjectorCommand(command) {
    const display = document.getElementById('projector-display');

    if (command.type === 'playAudio') {
        playAudioSynced(command.file, command.startTime, command.loop);
    } else if (command.type === 'stopAudio') {
        stopAudio();
    } else if (command.type === 'color') {
        display.style.backgroundColor = command.value;
        console.log('Changed projector color to:', command.value);
    } else if (command.type === 'drumHit') {
        // Play drum sound when participant hits drum
        playDrumSound();
    } else if (command.type === 'flash') {
        startFlashing(command.startTime, command.interval);
    }
}

function listenForProjectorParticipants() {
    if (!db || !roomId) {
        console.error('Firebase not initialized or no room ID');
        return;
    }

    const participantsRef = db.ref(`rooms/${roomId}/participants`);

    participantsRef.on('value', (snapshot) => {
        const count = snapshot.numChildren();
        document.getElementById('projector-participant-count').textContent = `Participants: ${count}`;
        console.log('Participant count:', count);
    });
}

// ============================================================================
// PARTICIPANT MODE
// ============================================================================

// Preload all audio files from manifest using Web Audio API
async function preloadAudioFiles() {
    try {
        // Create AudioContext (may need user interaction first)
        if (!audioContext) {
            audioContext = new (window.AudioContext || window.webkitAudioContext)();
            console.log('✓ AudioContext created');
        }

        console.log('Fetching audio manifest...');
        const response = await fetch('samples/manifest.json');
        const manifest = await response.json();

        const files = manifest.files || [];
        audioLoadProgress.total = files.length;
        audioLoadProgress.loaded = 0;

        console.log(`Preloading ${files.length} audio files with Web Audio API...`);
        updateSyncStatus();

        // Preload all files using fetch + decodeAudioData
        const loadPromises = files.map(async (file) => {
            try {
                const response = await fetch(file);
                const arrayBuffer = await response.arrayBuffer();
                const audioBuffer = await audioContext.decodeAudioData(arrayBuffer);

                audioBuffers.set(file, audioBuffer);
                audioLoadProgress.loaded++;
                console.log(`Loaded ${file} (${audioLoadProgress.loaded}/${audioLoadProgress.total})`);
                updateSyncStatus();
            } catch (error) {
                console.error(`Failed to load ${file}:`, error);
                audioLoadProgress.loaded++;
                updateSyncStatus();
                // Continue even if one file fails
            }
        });

        await Promise.all(loadPromises);
        audioFilesLoaded = true;
        console.log('✓ All audio files preloaded and decoded');
        updateSyncStatus();
    } catch (error) {
        console.error('Failed to load audio manifest:', error);
        audioFilesLoaded = true;  // Don't block if manifest fails
        updateSyncStatus();
    }
}

function initParticipant() {
    console.log('Initializing participant mode for room:', roomId);

    // Show name entry screen first
    showView('name-entry-view');

    // Pre-fill name from localStorage if available
    const savedName = localStorage.getItem('crowdplay-name');
    if (savedName) {
        document.getElementById('name-input').value = savedName;
    }

    // Focus the input field
    setTimeout(() => {
        document.getElementById('name-input').focus();
    }, 100);

    // Handle form submission
    document.getElementById('name-entry-form').addEventListener('submit', async (e) => {
        e.preventDefault();
        const name = document.getElementById('name-input').value.trim();
        if (name) {
            await handleNameSubmit(name);
        }
    });
}

async function handleNameSubmit(name) {
    participantName = name;
    localStorage.setItem('crowdplay-name', name);
    console.log('Participant name:', name);

    // Request wake lock to keep screen on
    await requestWakeLock();

    // Unlock audio playback
    await unlockAudio();

    // Now proceed with normal participant initialization
    showView('participant-view');

    // Start preloading audio files
    preloadAudioFiles();

    // Initialize Firebase
    initFirebase();

    // Register as participant
    registerParticipant();

    // Listen for commands from conductor
    listenForCommands();

    // Start listening for drum hits (accelerometer)
    startDrumDetection();

    // Update status
    document.getElementById('participant-status').textContent = `Welcome, ${name}!`;
}

async function requestWakeLock() {
    if ('wakeLock' in navigator) {
        try {
            wakeLock = await navigator.wakeLock.request('screen');
            console.log('✓ Screen wake lock active');

            // Re-request if visibility changes (user switches tabs)
            document.addEventListener('visibilitychange', async () => {
                if (wakeLock !== null && document.visibilityState === 'visible') {
                    wakeLock = await navigator.wakeLock.request('screen');
                }
            });
        } catch (err) {
            console.warn('Wake lock failed (not critical):', err);
        }
    } else {
        console.warn('Wake Lock API not supported');
    }
}

async function unlockAudio() {
    try {
        // Resume AudioContext if it's suspended (required on iOS and some browsers)
        if (audioContext && audioContext.state === 'suspended') {
            await audioContext.resume();
            console.log('✓ AudioContext resumed');
        }

        // Also play silent audio as backup for older browsers
        const silentAudio = new Audio();
        silentAudio.src = 'data:audio/mp3;base64,SUQzBAAAAAABEVRYWFgAAAAtAAADY29tbWVudABCaWdTb3VuZEJhbmsuY29tIC8gTGFTb25vdGhlcXVlLm9yZwBURU5DAAAAHQAAA1N3aXRjaCBQbHVzIMKpIE5DSCBTb2Z0d2FyZQBUSVQyAAAABgAAAzIyMzUAVFNTRQAAAA8AAANMYXZmNTcuODMuMTAwAAAAAAAAAAAAAAD/80DEAAAAA0gAAAAATEFNRTMuMTAwVVVVVVVVVVVVVUxBTUUzLjEwMFVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVf/zQsRbAAADSAAAAABVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVf/zQMSkAAADSAAAAABVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVV';
        await silentAudio.play();
        console.log('✓ Audio unlocked');
    } catch (err) {
        console.warn('Audio unlock failed (user may need to interact):', err);
    }
}

function requestFullscreen() {
    try {
        if (document.documentElement.requestFullscreen) {
            document.documentElement.requestFullscreen().catch(err => {
                console.log('Fullscreen request declined (not critical):', err.message);
            });
        }
    } catch (err) {
        console.log('Fullscreen not supported');
    }
}

function registerParticipant() {
    if (!db || !roomId) {
        console.error('Firebase not initialized or no room ID');
        return;
    }

    // Generate a unique participant ID (stored globally for heartbeats)
    participantId = 'participant_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);

    const participantRef = db.ref(`rooms/${roomId}/participants/${participantId}`);
    participantRef.set({
        name: participantName,
        joinedAt: Date.now()
    });

    // Remove participant when they leave
    participantRef.onDisconnect().remove();

    console.log('Registered as participant:', participantId);
}

function listenForCommands() {
    if (!db || !roomId) {
        console.error('Firebase not initialized or no room ID');
        return;
    }

    const commandsRef = db.ref(`rooms/${roomId}/toClients`);

    // Only listen to commands created AFTER we connect (ignore backlog)
    const joinTime = Date.now();
    console.log('Listening for commands created after:', joinTime);

    commandsRef.orderByChild('timestamp').startAt(joinTime).on('child_added', (snapshot) => {
        const command = snapshot.val();
        console.log('Received command:', command);

        handleCommand(command);

        // Optional: Remove old commands to keep database clean
        // snapshot.ref.remove();
    });
}

function handleCommand(command) {
    const display = document.getElementById('display');

    if (command.type === 'state') {
        // Conductor sent a state update (includes latency probe)
        // Calculate latency: how long did it take for message to arrive?
        const latency = getSyncedTime() - command.timestamp;

        // Send heartbeat back to conductor with latency measurement
        sendHeartbeat(latency);

        console.log(`State update received, latency: ${Math.round(latency)}ms`);

        // TODO: Apply any game state from command
    } else if (command.type === 'playAudio') {
        playAudioSynced(command.file, command.startTime, command.loop);
    } else if (command.type === 'stopAudio') {
        stopAudio();
    } else if (command.type === 'color') {
        display.style.backgroundColor = command.value;
        console.log('Changed color to:', command.value);

        // Hide status text when showing colors
        const statusEl = document.getElementById('participant-status');
        if (command.value === 'black' || command.value === 'white') {
            statusEl.style.display = 'none';
        }
    } else if (command.type === 'flash') {
        startFlashing(command.startTime, command.interval);
    }
}

// Send heartbeat to conductor with latency measurement
function sendHeartbeat(latency) {
    if (!db || !roomId || !participantId) {
        console.error('Cannot send heartbeat: Firebase not initialized or no participant ID');
        return;
    }

    const heartbeatRef = db.ref(`rooms/${roomId}/toController`).push();
    heartbeatRef.set({
        type: 'heartbeat',
        clientId: participantId,
        name: participantName,
        latency: Math.round(latency),
        timestamp: getSyncedTime()
    });
}

// Start listening for drum hit detection using accelerometer
function startDrumDetection() {
    // Check if DeviceMotionEvent is available
    if (typeof DeviceMotionEvent === 'undefined') {
        console.warn('DeviceMotionEvent not supported on this device');
        return;
    }

    // iOS 13+ requires permission
    if (typeof DeviceMotionEvent.requestPermission === 'function') {
        DeviceMotionEvent.requestPermission()
            .then(permissionState => {
                if (permissionState === 'granted') {
                    addMotionListener();
                } else {
                    console.warn('Motion permission denied');
                }
            })
            .catch(err => console.error('Error requesting motion permission:', err));
    } else {
        // Non-iOS or older iOS, just add listener
        addMotionListener();
    }
}

function addMotionListener() {
    window.addEventListener('devicemotion', (event) => {
        // Get acceleration with gravity
        const acc = event.accelerationIncludingGravity;
        if (!acc || acc.x === null) return;

        // Calculate magnitude of acceleration vector
        const magnitude = Math.sqrt(
            acc.x * acc.x +
            acc.y * acc.y +
            acc.z * acc.z
        );

        // Detect sharp motion (drum hit)
        if (magnitude > DRUM_THRESHOLD) {
            // Check throttle
            const now = Date.now();
            if (now - lastDrumHitTime >= DRUM_THROTTLE_MS) {
                lastDrumHitTime = now;
                sendDrumHit(magnitude);
                console.log(`Drum hit detected! Magnitude: ${magnitude.toFixed(1)}`);
            }
        }
    });

    console.log('✓ Drum detection started (shake your phone!)');
}

// Send drum hit event to conductor
function sendDrumHit(magnitude) {
    if (!db || !roomId || !participantId) {
        console.error('Cannot send drum hit: Firebase not initialized');
        return;
    }

    const drumHitRef = db.ref(`rooms/${roomId}/toController`).push();
    drumHitRef.set({
        type: 'drumHit',
        clientId: participantId,
        name: participantName,
        magnitude: Math.round(magnitude),
        timestamp: getSyncedTime()
    });
}

// Play audio synchronized to a specific start time using Web Audio API
function playAudioSynced(file, startTime, loop) {
    if (!isSynced) {
        console.warn('Cannot play audio: not yet time-synced');
        return;
    }

    if (!audioContext || !audioFilesLoaded) {
        console.warn('Cannot play audio: AudioContext not ready or files still loading');
        return;
    }

    console.log(`Playing audio: ${file}, startTime: ${startTime}, loop: ${loop}`);

    // Stop any currently playing audio
    stopAudio();

    // Get the decoded audio buffer
    const audioBuffer = audioBuffers.get(file);
    if (!audioBuffer) {
        console.error(`Audio buffer not found for: ${file}`);
        return;
    }

    // Calculate where we should be in the audio based on synced time
    const now = getSyncedTime();
    const elapsed = (now - startTime) / 1000; // seconds since scheduled start

    if (elapsed < -5) {
        console.warn(`Audio scheduled too far in future (${Math.round(elapsed)}s), skipping`);
        return;
    }

    // Create a buffer source node
    const source = audioContext.createBufferSource();
    source.buffer = audioBuffer;
    source.loop = loop;
    source.connect(audioContext.destination);

    // Calculate offset and when to start in AudioContext time
    let offset = 0;
    let whenToStart = audioContext.currentTime;

    if (elapsed > 0) {
        // We're late - calculate position in the loop
        if (loop) {
            offset = elapsed % audioBuffer.duration;
        } else {
            offset = Math.min(elapsed, audioBuffer.duration);
            if (offset >= audioBuffer.duration) {
                console.warn('Audio already finished, not playing');
                return;
            }
        }
        // Start immediately
        whenToStart = audioContext.currentTime;
        console.log(`Late by ${elapsed.toFixed(3)}s - starting at offset ${offset.toFixed(3)}s`);
    } else {
        // We're early - schedule precisely in the future
        // Use AudioContext time which has millisecond precision
        whenToStart = audioContext.currentTime + Math.abs(elapsed);
        offset = 0;
        console.log(`Early by ${Math.abs(elapsed).toFixed(3)}s - scheduling at audioContext time ${whenToStart.toFixed(3)}s`);
    }

    // Start at the calculated time with the calculated offset
    // This is PRECISE - Web Audio API guarantees sample-accurate timing
    source.start(whenToStart, offset);
    currentSource = source;

    console.log(`Audio scheduled: start=${whenToStart.toFixed(3)}s, offset=${offset.toFixed(3)}s, duration=${audioBuffer.duration.toFixed(3)}s`);
}

// Stop currently playing audio
function stopAudio() {
    if (currentSource) {
        try {
            currentSource.stop();
            currentSource.disconnect();
        } catch (err) {
            // Source may have already stopped or not started yet
        }
        currentSource = null;
        console.log('Audio stopped');
    }
}

// Play drum sound (instant feedback, no sync needed) using Web Audio API
function playDrumSound() {
    if (!audioContext || !audioFilesLoaded) {
        console.warn('Cannot play drum: AudioContext not ready');
        return;
    }

    const drumFile = 'samples/drum.mp3';
    const drumBuffer = audioBuffers.get(drumFile);

    if (!drumBuffer) {
        console.error(`Drum buffer not found: ${drumFile}`);
        return;
    }

    // Create a new source for this drum hit (don't stop looping audio)
    const drumSource = audioContext.createBufferSource();
    drumSource.buffer = drumBuffer;
    drumSource.connect(audioContext.destination);
    drumSource.start(audioContext.currentTime);

    console.log('Drum sound played');
}

// Start synchronized flashing (for time sync testing)
function startFlashing(startTime, interval) {
    // Stop any existing flash
    stopFlashing();

    flashStartTime = startTime;
    flashInterval = interval;

    console.log(`Starting synchronized flash at ${startTime}, every ${interval}ms`);

    // Function to check if it's time to flash
    const checkAndFlash = () => {
        // Check if we've been cancelled
        if (flashStartTime !== startTime) {
            console.log('Flash cancelled, stopping');
            return;
        }

        const now = getSyncedTime();
        const elapsed = now - flashStartTime;

        if (elapsed < 0) {
            // Not time yet, check again soon
            flashIntervalId = setTimeout(checkAndFlash, Math.max(10, -elapsed));
            return;
        }

        // Calculate how far into the current cycle we are
        const cyclePosition = elapsed % flashInterval;

        // If we're within 50ms of a flash time, trigger it
        if (cyclePosition < 50) {
            doFlash();
            // Schedule next check after this cycle
            flashIntervalId = setTimeout(checkAndFlash, flashInterval - cyclePosition + 10);
        } else {
            // Schedule next check at the next flash time
            const timeUntilNextFlash = flashInterval - cyclePosition;
            flashIntervalId = setTimeout(checkAndFlash, Math.max(10, timeUntilNextFlash - 50));
        }
    };

    checkAndFlash();
}

// Stop flashing
function stopFlashing() {
    if (flashIntervalId) {
        clearTimeout(flashIntervalId);
        flashIntervalId = null;
    }
    flashStartTime = null;
}

// Perform a single flash (white for 100ms)
function doFlash() {
    const display = mode === 'projector'
        ? document.getElementById('projector-display')
        : document.getElementById('display');

    if (!display) return;

    const originalColor = display.style.backgroundColor;

    // Flash white
    display.style.backgroundColor = 'white';
    console.log(`Flash! (time: ${getSyncedTime()})`);

    // Restore after 100ms
    setTimeout(() => {
        display.style.backgroundColor = originalColor;
    }, 100);
}

// ============================================================================
// FIREBASE INITIALIZATION
// ============================================================================

function initFirebase() {
    if (firebaseConfig.apiKey === 'YOUR_API_KEY') {
        console.warn('⚠️  Firebase not configured yet. Please add your Firebase config to app.js');
        console.warn('The app will not work until Firebase is configured.');
        setStatus('warning', 'Firebase not configured');
        return;
    }

    try {
        firebase.initializeApp(firebaseConfig);
        db = firebase.database();
        console.log('Firebase initialized successfully');

        // Monitor connection status
        monitorConnection();

        // Monitor server time for synchronization
        monitorServerTime();
    } catch (error) {
        console.error('Firebase initialization error:', error);
        setStatus('error', 'Firebase init failed: ' + error.message);
    }
}
