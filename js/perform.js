// CrowdPlay - Perform Role
// Runs on laptop projected to audience with big speakers

// ============================================================================
// PERFORM STATE
// ============================================================================

let currentGame = null;
let audioBuffers = new Map();
let audioFilesLoaded = false;
let currentAudioSource = null;

// Participant tracking
let participantCount = 0;
let clientLatencies = new Map();
const MAX_LATENCY_MS = 5000;

// ============================================================================
// INITIALIZATION
// ============================================================================

// Initialize immediately (script is loaded after DOM is ready)
(async function initPerform() {
    console.log('Perform mode initializing...');

    showView('perform-view');

    // Get room ID from localStorage or generate new one
    const savedRoomId = localStorage.getItem('crowdplay-roomId');
    if (savedRoomId) {
        roomId = savedRoomId;
        console.log('Reusing saved room ID:', roomId);
    } else {
        roomId = generateRoomID();
        localStorage.setItem('crowdplay-roomId', roomId);
        console.log('Generated new room ID:', roomId);
    }

    document.getElementById('perform-room-id').textContent = roomId;
    console.log('Room ID set to:', roomId);

    // Generate QR code for audience
    const roomURL = window.location.origin + window.location.pathname + '?room=' + roomId;
    console.log('Generating QR code for:', roomURL);

    new QRCode(document.getElementById('perform-qr-code'), {
        text: roomURL,
        width: 256,
        height: 256
    });

    // Initialize Firebase
    initFirebase();

    // Preload audio assets
    await preloadAudioAssets();

    // Register presence
    registerPresence('Perform', 'perform');

    // Listen for Control commands
    listenForControlCommands();

    // Monitor participants
    monitorParticipants();

    // Monitor latency from audience
    listenForLatencyReports();

    // Start sending diagnostics to Control
    startDiagnosticsBroadcast();

    // Start with QR game
    console.log('Starting QR game...');
    await changeGame('qr');

    console.log('✓ Perform mode ready');
})();

function generateRoomID() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let result = '';
    for (let i = 0; i < 6; i++) {
        result += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return result;
}

// ============================================================================
// ASSET LOADING
// ============================================================================

async function preloadAudioAssets() {
    try {
        const ctx = getOrCreateAudioContext();

        console.log('Fetching audio manifest...');
        const response = await fetch('samples/manifest.json');
        const manifest = await response.json();

        const files = manifest.files || [];
        console.log(`Preloading ${files.length} audio files...`);

        const loadPromises = files.map(async (file) => {
            try {
                const response = await fetch(file);
                const arrayBuffer = await response.arrayBuffer();
                const audioBuffer = await ctx.decodeAudioData(arrayBuffer);
                audioBuffers.set(file, audioBuffer);
                console.log(`Loaded ${file}`);
            } catch (error) {
                console.error(`Failed to load ${file}:`, error);
            }
        });

        await Promise.all(loadPromises);
        audioFilesLoaded = true;
        console.log('✓ All audio files preloaded');
    } catch (error) {
        console.error('Failed to load audio manifest:', error);
        audioFilesLoaded = true;
    }
}

// ============================================================================
// GAME STATE MACHINE
// ============================================================================

async function changeGame(gameName, config = {}) {
    console.log(`Changing game to: ${gameName}`);

    // Teardown current game
    if (currentGame) {
        await currentGame.teardown();
        currentGame = null;
    }

    // Create new game
    const GameClass = getGameClass(gameName);
    if (!GameClass) {
        console.error(`Unknown game: ${gameName}`);
        return;
    }

    currentGame = new GameClass('perform', config);
    await currentGame.init();

    // Broadcast new game state to audience
    broadcastGameState(gameName, config);

    // Update diagnostics
    sendDiagnostics();
}

function getGameClass(gameName) {
    const gameMap = {
        'qr': PerformQRGame,
        'clap': PerformClapGame,
        'drum': PerformDrumGame,
        'music': PerformMusicGame,
        'flash': PerformFlashGame
    };
    return gameMap[gameName];
}

function broadcastGameState(gameName, config) {
    if (!db || !roomId) return;

    db.ref(`rooms/${roomId}/toAudience`).set({
        type: 'gameState',
        game: gameName,
        config: config,
        timestamp: getSyncedTime()
    });

    console.log(`Broadcast game state: ${gameName}`);
}

// ============================================================================
// CONTROL INTERFACE
// ============================================================================

function listenForControlCommands() {
    if (!db || !roomId) return;

    const commandsRef = db.ref(`rooms/${roomId}/fromControl`);

    commandsRef.on('child_added', (snapshot) => {
        const command = snapshot.val();
        console.log('Received command from Control:', command);

        handleControlCommand(command);

        // Remove processed command
        snapshot.ref.remove();
    });
}

function handleControlCommand(command) {
    if (command.type === 'changeGame') {
        changeGame(command.game, command.config || {});
    }
}

// ============================================================================
// PARTICIPANT MONITORING
// ============================================================================

function monitorParticipants() {
    if (!db || !roomId) return;

    const participantsRef = db.ref(`rooms/${roomId}/participants`);

    participantsRef.on('value', (snapshot) => {
        participantCount = 0;
        snapshot.forEach((child) => {
            const data = child.val();
            if (data.role === 'audience') {
                participantCount++;
            }
        });

        document.getElementById('perform-participant-count').textContent = participantCount;
        sendDiagnostics();
    });
}

function listenForLatencyReports() {
    if (!db || !roomId) return;

    const messagesRef = db.ref(`rooms/${roomId}/toPerform`);

    messagesRef.on('child_added', (snapshot) => {
        const message = snapshot.val();

        if (message.type === 'latency') {
            const clientId = message.clientId;
            const latency = message.latency;

            if (latency < MAX_LATENCY_MS) {
                clientLatencies.set(clientId, {
                    name: message.name || 'Unknown',
                    latency: latency,
                    lastSeen: Date.now()
                });
            }

            // Clean up old clients
            const now = Date.now();
            for (const [id, data] of clientLatencies.entries()) {
                if (now - data.lastSeen > 30000) {
                    clientLatencies.delete(id);
                }
            }

            updateLatencyDisplay();
            sendDiagnostics();
        } else if (message.type === 'drumHit') {
            // Play drum sound when audience member hits drum
            playDrumSound();
        }

        snapshot.ref.remove();
    });
}

function calculate95thPercentileLatency() {
    if (clientLatencies.size === 0) return 0;

    const latencies = Array.from(clientLatencies.values())
        .map(data => data.latency)
        .sort((a, b) => a - b);

    const index = Math.ceil(latencies.length * 0.95) - 1;
    return latencies[Math.max(0, index)];
}

function updateLatencyDisplay() {
    const latency95th = calculate95thPercentileLatency();
    document.getElementById('perform-latency-95th').textContent =
        latency95th > 0 ? `${Math.round(latency95th)}ms` : '--';
}

// ============================================================================
// DIAGNOSTICS TO CONTROL
// ============================================================================

function startDiagnosticsBroadcast() {
    // Send immediately
    sendDiagnostics();

    // Then send every 2 seconds
    setInterval(sendDiagnostics, 2000);
}

function sendDiagnostics() {
    if (!db || !roomId) return;

    db.ref(`rooms/${roomId}/toControl`).set({
        participantCount: participantCount,
        latency95th: calculate95thPercentileLatency(),
        currentGame: currentGame ? currentGame.constructor.name : 'none',
        timestamp: getSyncedTime()
    });
}

// ============================================================================
// AUDIO PLAYBACK
// ============================================================================

function playAudioSynced(file, startTime, loop) {
    if (!isSynced) {
        console.warn('Cannot play audio: not yet time-synced');
        return;
    }

    const ctx = getOrCreateAudioContext();
    if (!audioFilesLoaded) {
        console.warn('Cannot play audio: files still loading');
        return;
    }

    stopAudio();

    const audioBuffer = audioBuffers.get(file);
    if (!audioBuffer) {
        console.error(`Audio buffer not found: ${file}`);
        return;
    }

    const targetAudioTime = syncedTimeToAudioTime(startTime);
    const currentAudioTime = ctx.currentTime;
    const timeUntilStart = targetAudioTime - currentAudioTime;

    console.log(`Audio: target=${targetAudioTime.toFixed(3)}s, current=${currentAudioTime.toFixed(3)}s, wait=${timeUntilStart.toFixed(3)}s`);

    const source = ctx.createBufferSource();
    source.buffer = audioBuffer;
    source.loop = loop;
    source.connect(ctx.destination);

    let offset = 0;
    let whenToStart = currentAudioTime;

    if (timeUntilStart < 0) {
        const lateBy = Math.abs(timeUntilStart);
        if (loop) {
            offset = lateBy % audioBuffer.duration;
        } else {
            offset = Math.min(lateBy, audioBuffer.duration);
            if (offset >= audioBuffer.duration) {
                console.warn('Audio already finished');
                return;
            }
        }
        whenToStart = currentAudioTime;
        console.log(`Late by ${lateBy.toFixed(3)}s - starting at offset ${offset.toFixed(3)}s`);
    } else {
        whenToStart = targetAudioTime;
        console.log(`Scheduling at ${whenToStart.toFixed(3)}s`);
    }

    source.start(whenToStart, offset);
    currentAudioSource = source;
}

function stopAudio() {
    if (currentAudioSource) {
        try {
            currentAudioSource.stop();
            currentAudioSource.disconnect();
        } catch (err) {
            // Already stopped
        }
        currentAudioSource = null;
    }
}

function playDrumSound() {
    const ctx = getOrCreateAudioContext();
    const drumBuffer = audioBuffers.get('samples/drum.mp3');

    if (!drumBuffer) {
        console.error('Drum buffer not found');
        return;
    }

    const source = ctx.createBufferSource();
    source.buffer = drumBuffer;
    source.connect(ctx.destination);
    source.start(ctx.currentTime);
}

// ============================================================================
// GAME IMPLEMENTATIONS - PERFORM
// ============================================================================

class PerformQRGame extends Game {
    async init() {
        await super.init();
        const display = document.getElementById('perform-display');
        display.style.background = 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)';
        display.innerHTML = `
            <div style="text-align: center;">
                <h1 style="font-size: 4rem; margin-bottom: 2rem; text-shadow: 2px 2px 4px rgba(0,0,0,0.3);">Join CrowdPlay!</h1>
                <p style="font-size: 2rem; margin-bottom: 3rem; opacity: 0.9;">Scan the QR code</p>
                <div id="qr-code-display"></div>
            </div>
        `;

        // Generate QR code in the display area
        const roomURL = window.location.origin + window.location.pathname + '?room=' + roomId;
        new QRCode(document.getElementById('qr-code-display'), {
            text: roomURL,
            width: 300,
            height: 300
        });
    }

    async teardown() {
        document.getElementById('perform-display').style.background = '';
        await super.teardown();
    }
}

class PerformClapGame extends Game {
    async init() {
        await super.init();
        document.getElementById('perform-display').innerHTML = `
            <h1 style="font-size: 5rem;">👏 CLAP! 👏</h1>
        `;

        // Schedule clap loop
        const startTime = getSyncedTime() + 1000;
        playAudioSynced('samples/clap.mp3', startTime, true);
    }

    async teardown() {
        stopAudio();
        await super.teardown();
    }
}

class PerformDrumGame extends Game {
    async init() {
        await super.init();
        document.getElementById('perform-display').innerHTML = `
            <h1 style="font-size: 5rem;">🥁 DRUM! 🥁</h1>
            <p style="font-size: 2rem;">Shake your phone!</p>
        `;
    }

    async teardown() {
        await super.teardown();
    }
}

class PerformMusicGame extends Game {
    async init() {
        await super.init();
        document.getElementById('perform-display').innerHTML = `
            <h1 style="font-size: 5rem;">🎵 MUSIC 🎵</h1>
        `;

        const startTime = getSyncedTime() + 1000;
        playAudioSynced('samples/sandstorm.mp3', startTime, false);
    }

    async teardown() {
        stopAudio();
        await super.teardown();
    }
}

class PerformFlashGame extends Game {
    async init() {
        await super.init();
        document.getElementById('perform-display').innerHTML = `
            <h1 style="font-size: 5rem;">⚡ FLASH SYNC TEST ⚡</h1>
            <p style="font-size: 2rem;">Watch all devices flash together</p>
        `;

        // Start flashing every 3 seconds
        const startTime = getSyncedTime() + 1000;
        const interval = 3000;

        // Broadcast config to audience
        this.broadcastFlashConfig(startTime, interval);
    }

    broadcastFlashConfig(startTime, interval) {
        // Send flash parameters as part of game config
        broadcastGameState('flash', { startTime, interval });
    }

    async teardown() {
        await super.teardown();
    }
}
