// CrowdPlay - Control Role
// Remote control for Perform (runs on mobile in portrait)

// ============================================================================
// INITIALIZATION
// ============================================================================

document.addEventListener('DOMContentLoaded', () => {
    console.log('Control mode initializing...');

    showView('control-view');

    // Get room ID from URL
    const params = new URLSearchParams(window.location.search);
    roomId = params.get('room');

    if (!roomId) {
        alert('No room ID specified. Add ?room=XXX to URL');
        return;
    }

    document.getElementById('control-room-id').textContent = roomId;

    // Initialize Firebase
    initFirebase();

    // Register presence
    registerPresence('Control', 'control');

    // Listen for diagnostics from Perform
    listenForDiagnostics();

    // Set up game buttons
    setupGameButtons();

    console.log('✓ Control mode ready');
});

// ============================================================================
// DIAGNOSTICS DISPLAY
// ============================================================================

function listenForDiagnostics() {
    if (!db || !roomId) return;

    const diagnosticsRef = db.ref(`rooms/${roomId}/toControl`);

    diagnosticsRef.on('value', (snapshot) => {
        const data = snapshot.val();
        if (!data) return;

        document.getElementById('control-participant-count').textContent = data.participantCount || 0;
        document.getElementById('control-latency-95th').textContent =
            data.latency95th > 0 ? `${Math.round(data.latency95th)}ms` : '--';
        document.getElementById('control-current-game').textContent = data.currentGame || 'none';
    });
}

// ============================================================================
// GAME CONTROL BUTTONS
// ============================================================================

function setupGameButtons() {
    const games = [
        { id: 'qr', label: 'QR Code', icon: '📱' },
        { id: 'clap', label: 'Clap', icon: '👏' },
        { id: 'drum', label: 'Drum', icon: '🥁' },
        { id: 'music', label: 'Music', icon: '🎵' }
    ];

    const buttonContainer = document.getElementById('control-game-buttons');

    games.forEach(game => {
        const button = document.createElement('button');
        button.className = 'game-button';
        button.innerHTML = `
            <div class="game-button-icon">${game.icon}</div>
            <div class="game-button-label">${game.label}</div>
        `;
        button.onclick = () => sendGameCommand(game.id);
        buttonContainer.appendChild(button);
    });
}

function sendGameCommand(gameName, config = {}) {
    if (!db || !roomId) {
        console.error('Cannot send command: Firebase not initialized');
        return;
    }

    console.log(`Sending game command: ${gameName}`);

    const commandRef = db.ref(`rooms/${roomId}/fromControl`).push();
    commandRef.set({
        type: 'changeGame',
        game: gameName,
        config: config,
        timestamp: getSyncedTime()
    });

    // Visual feedback
    document.getElementById('control-current-game').textContent = gameName;
}
