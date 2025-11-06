// CrowdPlay - Audience Role
// Runs on audience member's mobile device

// ============================================================================
// AUDIENCE STATE
// ============================================================================

let participantId = null;
let participantName = null;
let wakeLock = null;
let currentGame = null;

// Audio state
let audioBuffers = new Map();
let audioFilesLoaded = false;
let currentAudioSource = null;

// Drum detection
let lastDrumHitTime = 0;
const DRUM_THROTTLE_MS = 500;
const DRUM_THRESHOLD = 20;

// ============================================================================
// INITIALIZATION
// ============================================================================

// Initialize immediately (script is loaded after DOM is ready)
(function initAudience() {
    console.log('Audience mode initializing...');

    // Get room ID from URL
    const params = new URLSearchParams(window.location.search);
    roomId = params.get('room');

    if (!roomId) {
        alert('No room ID specified. Scan QR code or add ?room=XXX to URL');
        return;
    }

    // Show name entry screen
    showView('name-entry-view');

    // Pre-fill name from localStorage if available
    const savedName = localStorage.getItem('crowdplay-name');
    if (savedName) {
        document.getElementById('name-input').value = savedName;
    }

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
})();

async function handleNameSubmit(name) {
    participantName = name;
    localStorage.setItem('crowdplay-name', name);
    console.log('Participant name:', name);

    // Request wake lock
    await requestWakeLock();

    // Unlock audio
    await unlockAudioContext();

    // Show main view
    showView('audience-view');

    // Preload lightweight audio assets
    await preloadAudioAssets();

    // Initialize Firebase
    initFirebase();

    // Register presence
    participantId = registerPresence(name, 'audience');

    // Listen for game state changes
    listenForGameState();

    // Start latency reporting
    startLatencyReporting();

    console.log('✓ Audience mode ready');
}

async function requestWakeLock() {
    if ('wakeLock' in navigator) {
        try {
            wakeLock = await navigator.wakeLock.request('screen');
            console.log('✓ Screen wake lock active');

            document.addEventListener('visibilitychange', async () => {
                if (wakeLock !== null && document.visibilityState === 'visible') {
                    wakeLock = await navigator.wakeLock.request('screen');
                }
            });
        } catch (err) {
            console.warn('Wake lock failed:', err);
        }
    }
}

// ============================================================================
// ASSET LOADING (LIGHTWEIGHT)
// ============================================================================

async function preloadAudioAssets() {
    try {
        const ctx = getOrCreateAudioContext();

        // Only load essential audience audio
        const essentialFiles = [
            'samples/clap.mp3',
            'samples/drum.mp3',
            'samples/sandstorm.mp3'
        ];

        console.log(`Preloading ${essentialFiles.length} audio files...`);

        const loadPromises = essentialFiles.map(async (file) => {
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
        console.error('Failed to load audio:', error);
        audioFilesLoaded = true;
    }
}

// ============================================================================
// GAME STATE LISTENING
// ============================================================================

function listenForGameState() {
    if (!db || !roomId) return;

    const gameStateRef = db.ref(`rooms/${roomId}/toAudience`);

    gameStateRef.on('value', (snapshot) => {
        const state = snapshot.val();
        if (!state || state.type !== 'gameState') return;

        console.log('Received game state:', state.game);
        changeGame(state.game, state.config || {});
    });
}

async function changeGame(gameName, config) {
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

    currentGame = new GameClass('audience', config);
    await currentGame.init();
}

function getGameClass(gameName) {
    const gameMap = {
        'qr': AudienceQRGame,
        'clap': AudienceClapGame,
        'drum': AudienceDrumGame,
        'music': AudienceMusicGame
    };
    return gameMap[gameName];
}

// ============================================================================
// LATENCY REPORTING
// ============================================================================

function startLatencyReporting() {
    // Listen for state broadcasts from Perform (for latency measurement)
    if (!db || !roomId) return;

    const stateRef = db.ref(`rooms/${roomId}/toAudience`);

    stateRef.on('value', (snapshot) => {
        const state = snapshot.val();
        if (!state || !state.timestamp) return;

        const latency = getSyncedTime() - state.timestamp;

        // Send latency report to Perform
        const latencyRef = db.ref(`rooms/${roomId}/toPerform`).push();
        latencyRef.set({
            type: 'latency',
            clientId: participantId,
            name: participantName,
            latency: Math.round(latency),
            timestamp: getSyncedTime()
        });
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
    } else {
        whenToStart = targetAudioTime;
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

    if (!drumBuffer) return;

    const source = ctx.createBufferSource();
    source.buffer = drumBuffer;
    source.connect(ctx.destination);
    source.start(ctx.currentTime);
}

// ============================================================================
// DRUM DETECTION
// ============================================================================

function startDrumDetection() {
    if (typeof DeviceMotionEvent === 'undefined') {
        console.warn('DeviceMotionEvent not supported');
        return;
    }

    if (typeof DeviceMotionEvent.requestPermission === 'function') {
        DeviceMotionEvent.requestPermission()
            .then(permissionState => {
                if (permissionState === 'granted') {
                    addMotionListener();
                }
            })
            .catch(err => console.error('Motion permission error:', err));
    } else {
        addMotionListener();
    }
}

function addMotionListener() {
    window.addEventListener('devicemotion', (event) => {
        const acc = event.accelerationIncludingGravity;
        if (!acc || acc.x === null) return;

        const magnitude = Math.sqrt(
            acc.x * acc.x +
            acc.y * acc.y +
            acc.z * acc.z
        );

        if (magnitude > DRUM_THRESHOLD) {
            const now = Date.now();
            if (now - lastDrumHitTime >= DRUM_THROTTLE_MS) {
                lastDrumHitTime = now;
                playDrumSound();
                console.log(`Drum hit! Magnitude: ${magnitude.toFixed(1)}`);
            }
        }
    });

    console.log('✓ Drum detection started');
}

// ============================================================================
// GAME IMPLEMENTATIONS - AUDIENCE
// ============================================================================

class AudienceQRGame extends Game {
    async init() {
        await super.init();
        document.getElementById('audience-display').innerHTML = `
            <h1 style="font-size: 3rem;">Welcome!</h1>
            <p style="font-size: 1.5rem;">Waiting for the game to start...</p>
        `;
        document.getElementById('audience-display').style.backgroundColor = '#1a1a2e';
    }

    async teardown() {
        await super.teardown();
    }
}

class AudienceClapGame extends Game {
    async init() {
        await super.init();
        document.getElementById('audience-display').innerHTML = `
            <h1 style="font-size: 4rem;">👏</h1>
        `;
        document.getElementById('audience-display').style.backgroundColor = '#ff6b6b';

        // Play clap loop synchronized with Perform
        const startTime = getSyncedTime() + 500;
        playAudioSynced('samples/clap.mp3', startTime, true);
    }

    async teardown() {
        stopAudio();
        await super.teardown();
    }
}

class AudienceDrumGame extends Game {
    async init() {
        await super.init();
        document.getElementById('audience-display').innerHTML = `
            <h1 style="font-size: 4rem;">🥁</h1>
            <p style="font-size: 1.5rem;">Shake to drum!</p>
        `;
        document.getElementById('audience-display').style.backgroundColor = '#4ecdc4';

        // Start drum detection
        startDrumDetection();
    }

    async teardown() {
        // Motion listener persists, but that's okay
        await super.teardown();
    }
}

class AudienceMusicGame extends Game {
    async init() {
        await super.init();
        document.getElementById('audience-display').innerHTML = `
            <h1 style="font-size: 4rem;">🎵</h1>
        `;
        document.getElementById('audience-display').style.backgroundColor = '#9b59b6';

        // Play music synchronized with Perform
        const startTime = getSyncedTime() + 500;
        playAudioSynced('samples/sandstorm.mp3', startTime, false);
    }

    async teardown() {
        stopAudio();
        await super.teardown();
    }
}
