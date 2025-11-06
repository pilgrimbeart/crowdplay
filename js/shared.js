// CrowdPlay - Shared functionality across all roles
// This file is loaded by Perform, Control, and Audience

// ============================================================================
// FIREBASE CONFIGURATION
// ============================================================================

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
// GLOBAL STATE
// ============================================================================

let db = null;
let roomId = null;

// Time synchronization state
let serverTimeOffset = 0;
let isSynced = false;
let syncSampleCount = 0;
const SYNC_SAMPLES_NEEDED = 5;
const SYNC_FILTER_K = 0.6;

// ============================================================================
// UTILITY FUNCTIONS
// ============================================================================

function showView(viewId) {
    document.querySelectorAll('.view').forEach(view => {
        view.style.display = 'none';
    });
    const targetView = document.getElementById(viewId);
    if (targetView) {
        targetView.style.display = 'block';
    }
}

function setStatus(type, message = '') {
    const indicator = document.getElementById('status-indicator');
    if (!indicator) return;

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

function updateSyncStatus() {
    if (!isSynced) {
        setStatus('warning', `Syncing time... (${syncSampleCount}/${SYNC_SAMPLES_NEEDED})`);
    } else {
        setStatus('connected');
    }
}

// ============================================================================
// FIREBASE INITIALIZATION
// ============================================================================

function initFirebase() {
    if (firebaseConfig.apiKey === 'YOUR_API_KEY') {
        console.warn('⚠️  Firebase not configured yet.');
        setStatus('warning', 'Firebase not configured');
        return;
    }

    try {
        firebase.initializeApp(firebaseConfig);
        db = firebase.database();
        console.log('✓ Firebase initialized');

        monitorConnection();
        monitorServerTime();
    } catch (error) {
        console.error('Firebase initialization error:', error);
        setStatus('error', 'Firebase init failed: ' + error.message);
    }
}

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

// ============================================================================
// TIME SYNCHRONIZATION
// ============================================================================

function monitorServerTime() {
    if (!db) return;

    console.log('Starting RTT-based time synchronization...');

    // Use RTT-based sync: measure round-trip time to Firebase
    const takeSample = () => {
        const t1 = Date.now(); // Client time before send

        const syncRef = db.ref('sync-temp').push();

        syncRef.set({
            clientSendTime: t1,
            serverTime: firebase.database.ServerValue.TIMESTAMP
        }).then(() => {
            return syncRef.once('value');
        }).then((snapshot) => {
            const t2 = Date.now(); // Client time after receive
            const data = snapshot.val();
            const serverTime = data.serverTime;

            // Calculate RTT and estimated offset
            const rtt = t2 - t1;
            const estimatedServerTimeAtSend = serverTime;
            const estimatedServerTimeNow = serverTime + (rtt / 2);
            const estimatedOffset = estimatedServerTimeNow - t2;

            console.log(`RTT sync sample ${syncSampleCount + 1}: RTT=${rtt}ms, offset=${Math.round(estimatedOffset)}ms`);

            // Apply exponential moving average filter
            if (syncSampleCount === 0) {
                serverTimeOffset = estimatedOffset;
                console.log('Initial server time offset:', Math.round(serverTimeOffset), 'ms');
            } else {
                const oldOffset = serverTimeOffset;
                serverTimeOffset = SYNC_FILTER_K * serverTimeOffset + (1 - SYNC_FILTER_K) * estimatedOffset;
                console.log(`Filtered offset: ${Math.round(serverTimeOffset)}ms (prev: ${Math.round(oldOffset)}ms, raw: ${Math.round(estimatedOffset)}ms)`);
            }

            syncSampleCount++;

            if (syncSampleCount >= SYNC_SAMPLES_NEEDED && !isSynced) {
                isSynced = true;
                console.log('✓ Time synchronized! Final offset:', Math.round(serverTimeOffset), 'ms');
            }

            updateSyncStatus();

            // Clean up temp sync data
            syncRef.remove();

            // Take more samples during initialization
            if (syncSampleCount < SYNC_SAMPLES_NEEDED) {
                setTimeout(takeSample, 300);
            } else {
                // After initial sync, resync periodically to handle drift
                setTimeout(takeSample, 10000); // Resync every 10 seconds
            }
        }).catch(err => {
            console.error('Time sync error:', err);
            // Retry after delay
            setTimeout(takeSample, 1000);
        });
    };

    takeSample();
}

function getSyncedTime() {
    return Date.now() + serverTimeOffset;
}

// ============================================================================
// FIREBASE PRESENCE
// ============================================================================

function registerPresence(name, role) {
    if (!db || !roomId) {
        console.error('Cannot register presence: Firebase not initialized');
        return null;
    }

    const presenceId = role + '_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
    const presenceRef = db.ref(`rooms/${roomId}/participants/${presenceId}`);

    presenceRef.set({
        name: name,
        role: role,
        joinedAt: firebase.database.ServerValue.TIMESTAMP
    });

    presenceRef.onDisconnect().remove();

    console.log('Registered presence:', presenceId, 'as', role);
    return presenceId;
}

// ============================================================================
// GAME BASE CLASS
// ============================================================================

class Game {
    constructor(role, config = {}) {
        this.role = role;  // 'perform' or 'audience'
        this.config = config;
        this.active = false;
    }

    async init() {
        this.active = true;
        console.log(`Game ${this.constructor.name} initialized for ${this.role}`);
    }

    async teardown() {
        this.active = false;
        console.log(`Game ${this.constructor.name} torn down`);
    }

    handleEvent(event) {
        // Override in subclasses
    }
}

// ============================================================================
// WEB AUDIO API HELPERS
// ============================================================================

let audioContext = null;
let audioContextCreationSyncedTime = 0;
let audioContextCreationTime = 0;

function getOrCreateAudioContext() {
    if (!audioContext) {
        audioContext = new (window.AudioContext || window.webkitAudioContext)();
        audioContextCreationSyncedTime = getSyncedTime();
        audioContextCreationTime = audioContext.currentTime;
        console.log('✓ AudioContext created at synced time:', audioContextCreationSyncedTime,
                   'audio time:', audioContextCreationTime.toFixed(3));
    }
    return audioContext;
}

async function unlockAudioContext() {
    const ctx = getOrCreateAudioContext();
    if (ctx.state === 'suspended') {
        await ctx.resume();
        console.log('✓ AudioContext resumed');
    }
}

// Convert synced time to audioContext time
function syncedTimeToAudioTime(syncedTime) {
    return audioContextCreationTime + (syncedTime - audioContextCreationSyncedTime) / 1000;
}
