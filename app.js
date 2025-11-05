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

    // Initial read
    offsetRef.on('value', (snapshot) => {
        const firebaseOffset = snapshot.val(); // Firebase's estimate of our clock offset (ms)

        if (syncSampleCount === 0) {
            // First sample: just set it directly
            serverTimeOffset = firebaseOffset;
            console.log('Initial server time offset:', serverTimeOffset, 'ms');
        } else {
            // Subsequent samples: apply first-order filter
            const oldOffset = serverTimeOffset;
            serverTimeOffset = SYNC_FILTER_K * serverTimeOffset + (1 - SYNC_FILTER_K) * firebaseOffset;
            console.log(`Time sync: ${firebaseOffset}ms (filtered: ${Math.round(serverTimeOffset)}ms, prev: ${Math.round(oldOffset)}ms)`);
        }

        syncSampleCount++;

        // Check if we've achieved sync
        if (syncSampleCount >= SYNC_SAMPLES_NEEDED && !isSynced) {
            isSynced = true;
            console.log('✓ Time synchronized! Offset:', Math.round(serverTimeOffset), 'ms');
        }

        updateSyncStatus();
    });

    // Periodically re-check offset to catch clock drift (every 10 seconds)
    setInterval(() => {
        offsetRef.once('value', (snapshot) => {
            const firebaseOffset = snapshot.val();
            const oldOffset = serverTimeOffset;
            serverTimeOffset = SYNC_FILTER_K * serverTimeOffset + (1 - SYNC_FILTER_K) * firebaseOffset;

            // Only log if offset changed significantly (>5ms)
            if (Math.abs(firebaseOffset - oldOffset) > 5) {
                console.log(`Time drift detected: ${firebaseOffset}ms (filtered: ${Math.round(serverTimeOffset)}ms)`);
            }
        });
    }, 10000);
}

// Get current synchronized time (in milliseconds)
function getSyncedTime() {
    return Date.now() + serverTimeOffset;
}

// Update status indicator based on connection and sync state
function updateSyncStatus() {
    if (!isSynced) {
        setStatus('warning', `Syncing... (${syncSampleCount}/${SYNC_SAMPLES_NEEDED})`);
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
const SYNC_SAMPLES_NEEDED = 1;  // Firebase offset is already accurate, only need 1 sample
const SYNC_FILTER_K = 0.75;      // Filter constant: higher = slower to adapt

// Latency tracking (Conductor only)
let clientLatencies = new Map();  // clientId -> {latency, lastSeen}
const MAX_LATENCY_MS = 5000;      // Ignore latencies > 5s
const LATENCY_PROBE_INTERVAL = 10000;  // Send probes every 10s

// Participant ID and name (Participant only)
let participantId = null;
let participantName = null;
let wakeLock = null;  // Screen wake lock

// Audio playback state (Participant only)
let currentAudio = null;  // Currently playing audio element
let audioCache = new Map();  // filename -> Audio object (for preloading)
let audioFilesLoaded = false;  // Whether all audio files have been preloaded
let audioLoadProgress = { loaded: 0, total: 0 };  // Track loading progress

document.addEventListener('DOMContentLoaded', () => {
    console.log('Page loaded and ready!');

    const params = getURLParams();

    // Determine mode
    if (params.conduct) {
        mode = 'conductor';
        initConductor();
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
        file: 'samples/523947__p00ta5h__clap-cruising-120000-bpm.mp3',
        startTime: startTime,
        loop: true
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

// Listen for heartbeat messages from clients
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
// PARTICIPANT MODE
// ============================================================================

// Preload all audio files from manifest
async function preloadAudioFiles() {
    try {
        console.log('Fetching audio manifest...');
        const response = await fetch('samples/manifest.json');
        const manifest = await response.json();

        const files = manifest.files || [];
        audioLoadProgress.total = files.length;
        audioLoadProgress.loaded = 0;

        console.log(`Preloading ${files.length} audio files...`);
        updateSyncStatus();

        // Preload all files
        const loadPromises = files.map((file, index) => {
            return new Promise((resolve, reject) => {
                const audio = new Audio(file);
                audio.preload = 'auto';

                audio.addEventListener('canplaythrough', () => {
                    audioCache.set(file, audio);
                    audioLoadProgress.loaded++;
                    console.log(`Loaded ${file} (${audioLoadProgress.loaded}/${audioLoadProgress.total})`);
                    updateSyncStatus();
                    resolve();
                }, { once: true });

                audio.addEventListener('error', (e) => {
                    console.error(`Failed to load ${file}:`, e);
                    audioLoadProgress.loaded++;
                    updateSyncStatus();
                    resolve();  // Continue even if one file fails
                });

                // Trigger loading
                audio.load();
            });
        });

        await Promise.all(loadPromises);
        audioFilesLoaded = true;
        console.log('✓ All audio files preloaded');
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

    // Request fullscreen (optional, may be blocked on some browsers)
    requestFullscreen();

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
        // Play a silent audio file to unlock audio playback
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

// Play audio synchronized to a specific start time
function playAudioSynced(file, startTime, loop) {
    if (!isSynced) {
        console.warn('Cannot play audio: not yet time-synced');
        return;
    }

    if (!audioFilesLoaded) {
        console.warn('Cannot play audio: files still loading');
        return;
    }

    console.log(`Playing audio: ${file}, startTime: ${startTime}, loop: ${loop}`);

    // Get or create audio element
    let audio = audioCache.get(file);
    if (!audio) {
        audio = new Audio(file);
        audio.preload = 'auto';
        audioCache.set(file, audio);
    }

    audio.loop = loop;

    // Calculate when to start
    const now = getSyncedTime();
    const delay = startTime - now;

    if (delay > 50) {
        // Start in the future - wait then play
        console.log(`Waiting ${Math.round(delay)}ms before starting audio`);
        setTimeout(() => {
            audio.currentTime = 0;
            audio.play().catch(err => console.error('Audio play failed:', err));
            currentAudio = audio;
        }, delay);
    } else if (delay >= -5000) {
        // Slightly late or on time - start with offset
        // For looping audio, calculate position within loop
        const offset = Math.abs(delay) / 1000;
        console.log(`Starting audio with ${Math.round(delay)}ms offset (${offset.toFixed(2)}s into track)`);

        // Wait for audio metadata to load
        audio.addEventListener('loadedmetadata', () => {
            const actualOffset = loop ? (offset % audio.duration) : Math.min(offset, audio.duration);
            audio.currentTime = actualOffset;
            audio.play().catch(err => console.error('Audio play failed:', err));
        }, { once: true });

        // Trigger metadata load if needed
        audio.load();
        currentAudio = audio;
    } else {
        console.warn(`Too late to start audio (${Math.round(delay)}ms behind), skipping`);
    }
}

// Stop currently playing audio
function stopAudio() {
    if (currentAudio) {
        currentAudio.pause();
        currentAudio.currentTime = 0;
        console.log('Audio stopped');
    }
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
