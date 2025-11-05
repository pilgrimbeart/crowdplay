# CrowdPlay

An audience-participation game for live events.

## Overview

CrowdPlay enables ~300 audience members to interact with a shared display using their phones as controllers. Perfect for live performances, conferences, or interactive events.

## Features

### Implemented
- ✅ Conductor mode (access via `?conduct` URL parameter)
- ✅ Participant mode (access via `?room=XXXX` URL parameter)
- ✅ QR code generation for easy participant joining
- ✅ Real-time pub/sub messaging via Firebase Realtime Database
- ✅ Basic keyboard controls (B = black, W = white)
- ✅ Live participant counter

### Planned
- Motion-based interaction using device accelerometer
- Team-based collaborative musical experiences
- Audio synchronization
- Visual and haptic feedback
- Time synchronization for coordinated effects

## Tech Stack

- **Frontend**: HTML, CSS, JavaScript (Static site)
- **Hosting**: GitHub Pages
- **Real-time Backend**: Firebase Realtime Database
- **QR Codes**: qrcode.js
- **Time Synchronization**: NTP-style client-server sync (planned)

## Getting Started

### 1. Deploy to GitHub Pages

1. Go to your repository Settings → Pages
2. Source: Deploy from branch
3. Branch: Select your branch, folder: `/` (root)
4. Save and wait for deployment

### 2. Set up Firebase

Follow the detailed instructions in [FIREBASE_SETUP.md](FIREBASE_SETUP.md)

### 3. Run Your Event

**As Conductor:**
1. Open `https://your-username.github.io/crowdplay/?conduct`
2. A QR code will appear with a unique room code
3. Press **B** to turn all participant screens black
4. Press **W** to turn all participant screens white

**As Participant:**
1. Scan the QR code shown by the conductor
2. Your screen will connect to the room
3. Watch as the conductor controls your screen color!

## License

TBD
