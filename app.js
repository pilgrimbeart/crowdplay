// CrowdPlay - Main Application
console.log('CrowdPlay initialized!');

// ============================================================================
// CONFIGURATION
// ============================================================================

// Firebase configuration
// FIXED: Changed databaseURL to use .firebaseio.com instead of .firebasedatabase.app
const firebaseConfig = {
  apiKey: "AIzaSyAh0Dh_TE0r3PYahE9B86Jo3vui1QW96rU",
  authDomain: "crowdplay-2025.firebaseapp.com",
  databaseURL: "https://crowdplay-2025-default-rtdb.europe-west1.firebaseio.com",  // Fixed: was .firebasedatabase.app
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
            setStatus('connected');
        } else {
            console.warn('✗ Firebase disconnected');
            setStatus('error', 'Disconnected');
        }
    });
}

// ============================================================================
// MODE DETECTION AND INITIALIZATION
// ============================================================================

let mode = 'landing';
let roomId = null;
let db = null;

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
    }
});

// ============================================================================
// CONDUCTOR MODE
// ============================================================================

function initConductor() {
    console.log('Initializing conductor mode...');
    showView('conductor-view');

    // Generate room ID
    roomId = generateRoomID();
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
        }
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
        timestamp: Date.now()
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

// ============================================================================
// PARTICIPANT MODE
// ============================================================================

function initParticipant() {
    console.log('Initializing participant mode for room:', roomId);
    showView('participant-view');

    // Initialize Firebase
    initFirebase();

    // Register as participant
    registerParticipant();

    // Listen for commands from conductor
    listenForCommands();

    // Update status
    document.getElementById('participant-status').textContent = 'Connected to room ' + roomId;
}

function registerParticipant() {
    if (!db || !roomId) {
        console.error('Firebase not initialized or no room ID');
        return;
    }

    // Generate a unique participant ID
    const participantId = 'participant_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);

    const participantRef = db.ref(`rooms/${roomId}/participants/${participantId}`);
    participantRef.set({
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

    commandsRef.on('child_added', (snapshot) => {
        const command = snapshot.val();
        console.log('Received command:', command);

        handleCommand(command);

        // Optional: Remove old commands to keep database clean
        // snapshot.ref.remove();
    });
}

function handleCommand(command) {
    const display = document.getElementById('display');

    if (command.type === 'color') {
        display.style.backgroundColor = command.value;
        console.log('Changed color to:', command.value);

        // Hide status text when showing colors
        const statusEl = document.getElementById('participant-status');
        if (command.value === 'black' || command.value === 'white') {
            statusEl.style.display = 'none';
        }
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
    } catch (error) {
        console.error('Firebase initialization error:', error);
        setStatus('error', 'Firebase init failed: ' + error.message);
    }
}
