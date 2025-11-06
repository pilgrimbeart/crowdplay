// CrowdPlay - Audience Role
// Runs on audience member's mobile device

// ============================================================================
// AUDIENCE STATE
// ============================================================================

let participantId = null;
let participantName = null;
let participantTeam = null;
let wakeLock = null;
let currentGame = null;

// Team colors - desaturated for normal, saturated for powered-up
const TEAM_COLORS = [
    { normal: '#D0D0D0', powered: '#FFFFFF', name: 'White' },
    { normal: '#D4A574', powered: '#FFA500', name: 'Orange' },
    { normal: '#C66B6B', powered: '#FF0000', name: 'Red' },
    { normal: '#6B8EC6', powered: '#0000FF', name: 'Blue' },
    { normal: '#8BA888', powered: '#6B8E23', name: 'Olive' }
];

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

    // Assign team (persistent like name)
    const savedTeam = localStorage.getItem('crowdplay-team');
    if (savedTeam !== null) {
        participantTeam = parseInt(savedTeam);
    } else {
        participantTeam = Math.floor(Math.random() * TEAM_COLORS.length);
        localStorage.setItem('crowdplay-team', participantTeam);
    }
    console.log(`Assigned to team ${participantTeam} (${TEAM_NAMES[participantTeam]})`);

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

    // Start diagnostics display
    startDiagnosticsDisplay();

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
        'music': AudienceMusicGame,
        'flash': AudienceFlashGame,
        'chomp': AudienceChompGame
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
// DIAGNOSTICS DISPLAY
// ============================================================================

function startDiagnosticsDisplay() {
    const updateDiagnostics = () => {
        const localTime = Date.now();
        const syncedTime = getSyncedTime();

        // Display modulo 10,000 (repeats every 10 seconds)
        const localMod = Math.floor(localTime % 10000);
        const syncedMod = Math.floor(syncedTime % 10000);

        document.getElementById('diag-local').textContent = localMod.toString().padStart(4, '0');
        document.getElementById('diag-offset').textContent = Math.round(serverTimeOffset) + ' ms';
        document.getElementById('diag-synced').textContent = syncedMod.toString().padStart(4, '0');
    };

    // Update every 50ms for smooth display
    setInterval(updateDiagnostics, 50);

    // Update immediately
    updateDiagnostics();
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
        if (!acc || acc.x === null || acc.z === null) return;

        // Detect downward drum motion:
        // When phone is held screen-up, Z axis points upward (away from screen)
        // At rest: Z ≈ 9.8 (gravity)
        // Drumming DOWN: Z decreases significantly (acceleration toward rear/ground)

        // We want to detect when Z drops below a threshold, indicating downward stroke
        // DRUM_THRESHOLD is 20, so we check if Z-axis acceleration is significantly
        // below the resting value (9.8), indicating downward motion

        const zAccel = acc.z;
        const restingZ = 9.8; // Approximate gravity when phone is at rest, screen up
        const zDelta = restingZ - zAccel; // Positive when accelerating downward

        // Trigger drum when phone accelerates downward with sufficient force
        // zDelta > DRUM_THRESHOLD means strong downward acceleration
        if (zDelta > DRUM_THRESHOLD) {
            const now = Date.now();
            if (now - lastDrumHitTime >= DRUM_THROTTLE_MS) {
                lastDrumHitTime = now;
                playDrumSound();

                // Send drum hit to Perform
                sendDrumHitToPerform();

                console.log(`Drum hit! Z: ${zAccel.toFixed(1)}, delta: ${zDelta.toFixed(1)}`);
            }
        }
    });

    console.log('✓ Drum detection started (downward motion only)');
}

function sendDrumHitToPerform() {
    if (!db || !roomId) return;

    const drumHitRef = db.ref(`rooms/${roomId}/toPerform`).push();
    drumHitRef.set({
        type: 'drumHit',
        clientId: participantId,
        name: participantName,
        timestamp: getSyncedTime()
    });
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
        // Use startTime from Perform's config, or fallback to current time + 500ms
        const startTime = this.config.startTime || (getSyncedTime() + 500);
        console.log('Clap game starting at:', startTime, 'current time:', getSyncedTime(), 'late by:', getSyncedTime() - startTime);
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
        // Use startTime from Perform's config, or fallback to current time + 500ms
        const startTime = this.config.startTime || (getSyncedTime() + 500);
        console.log('Music game starting at:', startTime, 'current time:', getSyncedTime(), 'late by:', getSyncedTime() - startTime);
        playAudioSynced('samples/sandstorm.mp3', startTime, false);
    }

    async teardown() {
        stopAudio();
        await super.teardown();
    }
}

class AudienceFlashGame extends Game {
    async init() {
        await super.init();
        const display = document.getElementById('audience-display');
        display.style.backgroundColor = '#000';
        display.innerHTML = `
            <h1 style="font-size: 3rem;">⚡ FLASH TEST ⚡</h1>
        `;

        // Get flash parameters from config
        const startTime = this.config.startTime || (getSyncedTime() + 1000);
        const interval = this.config.interval || 3000;

        this.scheduleFlashes(startTime, interval);
    }

    scheduleFlashes(startTime, interval) {
        const display = document.getElementById('audience-display');

        // Schedule repeating flashes
        const flash = () => {
            if (!this.active) return;

            const now = getSyncedTime();
            const nextFlashTime = startTime + Math.ceil((now - startTime) / interval) * interval;
            const delay = nextFlashTime - now;

            setTimeout(() => {
                if (!this.active) return;

                // Binary flash - instant white, fade to black
                display.style.transition = 'none';
                display.style.backgroundColor = '#fff';

                setTimeout(() => {
                    if (!this.active) return;
                    display.style.transition = 'background-color 0.3s ease-out';
                    display.style.backgroundColor = '#000';
                }, 50);

                // Schedule next flash
                setTimeout(flash, interval - 50);
            }, Math.max(0, delay));
        };

        flash();
    }

    async teardown() {
        document.getElementById('audience-display').style.transition = '';
        await super.teardown();
    }
}

class AudienceChompGame extends Game {
    constructor(role, config) {
        super(role, config);
        this.orientationUpdateInterval = null;
        this.lastOrientation = { beta: 0, gamma: 0 };
    }

    async init() {
        await super.init();
        const display = document.getElementById('audience-display');
        const teamData = TEAM_COLORS[participantTeam];
        const teamColor = teamData.normal;
        const teamName = teamData.name;

        display.style.backgroundColor = teamColor;
        display.innerHTML = `
            <h1 style="font-size: 3rem;">🟡</h1>
            <p style="font-size: 2rem; font-weight: bold;">Team ${teamName}</p>
            <p style="font-size: 1.2rem; margin-top: 2rem;">Tilt your phone to steer!</p>
            <p id="chomp-debug" style="font-size: 0.9rem; margin-top: 1rem; opacity: 0.7;"></p>
        `;

        // Request device orientation permission (iOS 13+)
        if (typeof DeviceOrientationEvent !== 'undefined' &&
            typeof DeviceOrientationEvent.requestPermission === 'function') {
            try {
                const permission = await DeviceOrientationEvent.requestPermission();
                if (permission === 'granted') {
                    this.startOrientationTracking();
                } else {
                    display.innerHTML += '<p style="color: #fff;">Permission denied</p>';
                }
            } catch (err) {
                console.error('Orientation permission error:', err);
            }
        } else {
            // Non-iOS or older iOS
            this.startOrientationTracking();
        }
    }

    startOrientationTracking() {
        // Send orientation data to Perform 10 times per second
        this.orientationUpdateInterval = setInterval(() => {
            if (!this.active) return;

            const { beta, gamma } = this.lastOrientation;

            // Convert orientation to direction vector
            // beta: front-to-back tilt (-180 to 180), negative when tilted forward
            // gamma: left-to-right tilt (-90 to 90), positive when tilted right

            // Normalize to -1 to 1 range
            const dx = Math.max(-1, Math.min(1, gamma / 45)); // 45 degrees = full tilt
            const dy = Math.max(-1, Math.min(1, -beta / 45)); // Negative beta = forward = positive dy

            // Only send if magnitude is significant
            const magnitude = Math.sqrt(dx * dx + dy * dy);
            if (magnitude > 0.1) {
                this.sendDirection(dx, dy);
            }

            // Update debug display
            const debugEl = document.getElementById('chomp-debug');
            if (debugEl) {
                debugEl.textContent = `dx: ${dx.toFixed(2)}, dy: ${dy.toFixed(2)}`;
            }
        }, 100); // 10 times per second

        // Listen for device orientation changes
        window.addEventListener('deviceorientation', this.handleOrientation.bind(this));
        console.log('✓ Chomp orientation tracking started');
    }

    handleOrientation(event) {
        this.lastOrientation = {
            beta: event.beta || 0,  // front-back tilt
            gamma: event.gamma || 0 // left-right tilt
        };
    }

    sendDirection(dx, dy) {
        if (!db || !roomId) return;

        const directionRef = db.ref(`rooms/${roomId}/toPerform`).push();
        directionRef.set({
            type: 'direction',
            clientId: participantId,
            team: participantTeam,
            dx: dx,
            dy: dy,
            timestamp: getSyncedTime()
        });
    }

    async teardown() {
        if (this.orientationUpdateInterval) {
            clearInterval(this.orientationUpdateInterval);
        }
        window.removeEventListener('deviceorientation', this.handleOrientation);
        document.getElementById('audience-display').style.backgroundColor = '';
        await super.teardown();
    }
}
