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

    // NOTE: Game's init() is responsible for broadcasting state to audience
    // Don't broadcast here to avoid duplicate broadcasts

    // Update diagnostics
    sendDiagnostics();
}

function getGameClass(gameName) {
    const gameMap = {
        'qr': PerformQRGame,
        'clap': PerformClapGame,
        'drum': PerformDrumGame,
        'music': PerformMusicGame,
        'flash': PerformFlashGame,
        'chomp': PerformChompGame
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
        } else if (message.type === 'direction') {
            // Update team direction data for Chomp game
            if (currentGame && currentGame.teams) {
                const team = currentGame.teams[message.team];
                if (team) {
                    team.clients.set(message.clientId, {
                        dx: message.dx,
                        dy: message.dy,
                        timestamp: message.timestamp
                    });
                }
            }
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

        // Broadcast to audience
        broadcastGameState('qr', {});
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

        // Broadcast startTime to audience so they sync with us
        broadcastGameState('clap', { startTime: startTime });
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

        // Broadcast to audience
        broadcastGameState('drum', {});
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

        // Broadcast startTime to audience so they sync with us
        broadcastGameState('music', { startTime: startTime });
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

class PerformChompGame extends Game {
    constructor(role, config) {
        super(role, config);
        this.canvas = null;
        this.ctx = null;
        this.animationFrame = null;
        this.teams = [];
        this.teamData = [
            { normal: '#D0D0D0', powered: '#FFFFFF', name: 'White' },
            { normal: '#D4A574', powered: '#FFA500', name: 'Orange' },
            { normal: '#C66B6B', powered: '#FF0000', name: 'Red' },
            { normal: '#6B8EC6', powered: '#0000FF', name: 'Blue' },
            { normal: '#8BA888', powered: '#6B8E23', name: 'Olive' }
        ];
        this.powerPills = [];
        this.baddies = [];
        this.startTime = getSyncedTime();
        this.gameTime = 120000; // 2 minutes in ms
        this.lastBaddieSpawn = 0;
    }

    async init() {
        await super.init();

        const display = document.getElementById('perform-display');
        display.innerHTML = `
            <canvas id="chomp-canvas" width="1200" height="800"></canvas>
        `;

        this.canvas = document.getElementById('chomp-canvas');
        this.ctx = this.canvas.getContext('2d');

        // Initialize teams with Pacman entities
        for (let i = 0; i < 5; i++) {
            this.teams.push({
                id: i,
                colorData: this.teamData[i],
                name: this.teamData[i].name,
                startX: 200 + (i * 200),
                startY: 400,
                x: 200 + (i * 200),
                y: 400,
                vx: 0,
                vy: 0,
                angle: 0,
                mouthAngle: 0,
                powered: false,
                powerEndTime: 0,
                score: 0,
                clients: new Map()
            });
        }

        // Create 20 power pills scattered around
        for (let i = 0; i < 20; i++) {
            this.powerPills.push({
                x: 100 + Math.random() * 1000,
                y: 100 + Math.random() * 600,
                active: true
            });
        }

        this.startTime = getSyncedTime();
        this.gameLoop();
        broadcastGameState('chomp', {});
        console.log('✓ Chomp game started');
    }

    gameLoop() {
        if (!this.active) return;

        const now = getSyncedTime();
        const elapsed = now - this.startTime;
        const timeLeft = Math.max(0, this.gameTime - elapsed);

        // Clear canvas
        this.ctx.fillStyle = '#1a1a2e';
        this.ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);

        // Draw timer and scores at top
        this.drawHUD(timeLeft);

        // Spawn baddies occasionally
        if (now - this.lastBaddieSpawn > 5000 && this.baddies.length < 8) {
            this.spawnBaddie();
            this.lastBaddieSpawn = now;
        }

        // Update teams
        this.teams.forEach(team => {
            // Clean up old client data
            for (const [clientId, data] of team.clients.entries()) {
                if (now - data.timestamp > 500) {
                    team.clients.delete(clientId);
                }
            }

            // Average direction vectors
            let sumDx = 0, sumDy = 0;
            team.clients.forEach(data => {
                sumDx += data.dx;
                sumDy += data.dy;
            });

            const count = team.clients.size;
            if (count > 0) {
                team.vx = sumDx / count;
                team.vy = sumDy / count;
                if (team.vx !== 0 || team.vy !== 0) {
                    team.angle = Math.atan2(team.vy, team.vx);
                }
            } else {
                team.vx *= 0.95;
                team.vy *= 0.95;
            }

            // Check power-up expiry
            if (team.powered && now > team.powerEndTime) {
                team.powered = false;
            }

            // Update position (faster when powered)
            const speed = team.powered ? 5 : 3;
            team.x += team.vx * speed;
            team.y += team.vy * speed;

            // Wrap around edges
            if (team.x < 0) team.x = this.canvas.width;
            if (team.x > this.canvas.width) team.x = 0;
            if (team.y < 0) team.y = this.canvas.height;
            if (team.y > this.canvas.height) team.y = 0;

            // Animate mouth
            team.mouthAngle = (Math.sin(Date.now() / 100) * 0.3) + 0.3;

            // Check collisions with power pills
            this.powerPills.forEach(pill => {
                if (pill.active && this.distance(team.x, team.y, pill.x, pill.y) < 35) {
                    pill.active = false;
                    team.powered = true;
                    team.powerEndTime = now + 10000; // 10 seconds
                    team.score += 5;
                }
            });
        });

        // Update baddies
        this.baddies.forEach(baddie => {
            this.updateBaddie(baddie);
        });

        // Check baddie collisions with pacmans
        this.baddies.forEach(baddie => {
            this.teams.forEach(team => {
                if (this.distance(baddie.x, baddie.y, team.x, team.y) < 35) {
                    if (team.powered) {
                        // Pacman eats baddie
                        baddie.dead = true;
                        team.score += 20;
                    } else {
                        // Baddie eats pacman
                        team.x = team.startX;
                        team.y = team.startY;
                        team.score = Math.max(0, team.score - 20);
                    }
                }
            });
        });

        // Remove dead baddies
        this.baddies = this.baddies.filter(b => !b.dead);

        // Draw power pills
        this.powerPills.forEach(pill => {
            if (pill.active) {
                this.ctx.fillStyle = '#FFD700';
                this.ctx.beginPath();
                this.ctx.arc(pill.x, pill.y, 8, 0, Math.PI * 2);
                this.ctx.fill();
            }
        });

        // Draw baddies
        this.baddies.forEach(baddie => {
            if (baddie.type === 'octopus') {
                this.drawOctopus(baddie);
            } else {
                this.drawBee(baddie);
            }
        });

        // Draw pacmans
        this.teams.forEach(team => {
            // Draw direction vectors
            const color = team.powered ? team.colorData.powered : team.colorData.normal;
            this.ctx.strokeStyle = color;
            this.ctx.globalAlpha = 0.2;
            team.clients.forEach(data => {
                this.ctx.beginPath();
                this.ctx.moveTo(team.x, team.y);
                this.ctx.lineTo(team.x + data.dx * 50, team.y + data.dy * 50);
                this.ctx.lineWidth = 1;
                this.ctx.stroke();
            });
            this.ctx.globalAlpha = 1.0;

            this.drawPacman(team);

            // Draw team label
            this.ctx.fillStyle = '#fff';
            this.ctx.font = '14px Arial';
            this.ctx.textAlign = 'center';
            const count = team.clients.size;
            this.ctx.fillText(`${team.name} (${count})`, team.x, team.y + 50);
        });

        this.animationFrame = requestAnimationFrame(() => this.gameLoop());
    }

    distance(x1, y1, x2, y2) {
        return Math.sqrt((x2 - x1) ** 2 + (y2 - y1) ** 2);
    }

    drawHUD(timeLeft) {
        // Timer
        const mins = Math.floor(timeLeft / 60000);
        const secs = Math.floor((timeLeft % 60000) / 1000);
        this.ctx.fillStyle = '#fff';
        this.ctx.font = 'bold 32px Arial';
        this.ctx.textAlign = 'center';
        this.ctx.fillText(`${mins}:${secs.toString().padStart(2, '0')}`, this.canvas.width / 2, 40);

        // Scores
        this.ctx.font = 'bold 24px Arial';
        this.ctx.textAlign = 'left';
        let xPos = 50;
        this.teams.forEach(team => {
            this.ctx.fillStyle = team.powered ? team.colorData.powered : team.colorData.normal;
            this.ctx.fillText(`${team.score}`, xPos, 40);
            xPos += 150;
        });
    }

    spawnBaddie() {
        const edge = Math.floor(Math.random() * 4); // 0=top, 1=right, 2=bottom, 3=left
        let x, y;
        if (edge === 0) { x = Math.random() * this.canvas.width; y = 0; }
        else if (edge === 1) { x = this.canvas.width; y = Math.random() * this.canvas.height; }
        else if (edge === 2) { x = Math.random() * this.canvas.width; y = this.canvas.height; }
        else { x = 0; y = Math.random() * this.canvas.height; }

        this.baddies.push({
            type: Math.random() < 0.5 ? 'octopus' : 'bee',
            x, y,
            vx: 0, vy: 0,
            animFrame: 0,
            dead: false
        });
    }

    updateBaddie(baddie) {
        // Find nearest pacman
        let nearest = null;
        let nearestDist = Infinity;
        let nearestPowered = false;

        this.teams.forEach(team => {
            const dist = this.distance(baddie.x, baddie.y, team.x, team.y);
            if (dist < nearestDist) {
                nearestDist = dist;
                nearest = team;
                nearestPowered = team.powered;
            }
        });

        if (nearest) {
            const dx = nearest.x - baddie.x;
            const dy = nearest.y - baddie.y;
            const mag = Math.sqrt(dx * dx + dy * dy);

            if (mag > 0) {
                const speed = 3.5; // Faster than normal pacman
                const dir = nearestPowered ? -1 : 1; // Flee from powered pacmans
                baddie.vx = (dx / mag) * speed * dir;
                baddie.vy = (dy / mag) * speed * dir;
            }
        }

        baddie.x += baddie.vx;
        baddie.y += baddie.vy;
        baddie.animFrame++;

        // Keep on screen
        baddie.x = Math.max(20, Math.min(this.canvas.width - 20, baddie.x));
        baddie.y = Math.max(20, Math.min(this.canvas.height - 20, baddie.y));
    }

    drawPacman(team) {
        const ctx = this.ctx;
        const radius = 30;
        const color = team.powered ? team.colorData.powered : team.colorData.normal;

        ctx.save();
        ctx.translate(team.x, team.y);
        ctx.rotate(team.angle);

        // Draw Pacman body
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.arc(0, 0, radius, team.mouthAngle, Math.PI * 2 - team.mouthAngle);
        ctx.lineTo(0, 0);
        ctx.closePath();
        ctx.fill();

        // Draw eye
        ctx.fillStyle = '#000';
        ctx.beginPath();
        ctx.arc(radius / 3, -radius / 3, 4, 0, Math.PI * 2);
        ctx.fill();

        ctx.restore();
    }

    drawOctopus(baddie) {
        const ctx = this.ctx;
        ctx.save();
        ctx.translate(baddie.x, baddie.y);

        // Body
        ctx.fillStyle = '#9B59B6';
        ctx.beginPath();
        ctx.arc(0, 0, 15, 0, Math.PI * 2);
        ctx.fill();

        // Twirling tentacles (8 of them)
        for (let i = 0; i < 8; i++) {
            const angle = (i / 8) * Math.PI * 2 + baddie.animFrame * 0.05;
            const wave = Math.sin(baddie.animFrame * 0.1 + i) * 5;
            ctx.strokeStyle = '#9B59B6';
            ctx.lineWidth = 2;
            ctx.beginPath();
            ctx.moveTo(0, 0);
            ctx.quadraticCurveTo(
                Math.cos(angle) * 10 + wave,
                Math.sin(angle) * 10,
                Math.cos(angle) * 20,
                Math.sin(angle) * 20 + wave
            );
            ctx.stroke();
        }

        ctx.restore();
    }

    drawBee(baddie) {
        const ctx = this.ctx;
        ctx.save();
        ctx.translate(baddie.x, baddie.y);

        // Buzzing motion
        const buzz = Math.sin(baddie.animFrame * 0.3) * 2;

        // Body
        ctx.fillStyle = '#FFD700';
        ctx.beginPath();
        ctx.ellipse(buzz, 0, 12, 8, 0, 0, Math.PI * 2);
        ctx.fill();

        // Stripes
        ctx.strokeStyle = '#000';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(buzz - 6, -5);
        ctx.lineTo(buzz - 6, 5);
        ctx.moveTo(buzz, -5);
        ctx.lineTo(buzz, 5);
        ctx.moveTo(buzz + 6, -5);
        ctx.lineTo(buzz + 6, 5);
        ctx.stroke();

        // Wings (flapping)
        const wingAngle = Math.sin(baddie.animFrame * 0.5) * 0.3;
        ctx.fillStyle = 'rgba(255, 255, 255, 0.6)';
        ctx.beginPath();
        ctx.ellipse(-5 + buzz, -8, 8, 4, -0.5 + wingAngle, 0, Math.PI * 2);
        ctx.fill();
        ctx.beginPath();
        ctx.ellipse(-5 + buzz, 8, 8, 4, 0.5 - wingAngle, 0, Math.PI * 2);
        ctx.fill();

        ctx.restore();
    }

    async teardown() {
        if (this.animationFrame) {
            cancelAnimationFrame(this.animationFrame);
        }
        await super.teardown();
    }
}
