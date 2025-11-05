# Firebase Setup Guide

This guide will help you set up Firebase Realtime Database for CrowdPlay.

## Step 1: Create a Firebase Project

1. Go to [Firebase Console](https://console.firebase.google.com/)
2. Click "Add project"
3. Enter project name (e.g., "crowdplay")
4. Disable Google Analytics (not needed for this project)
5. Click "Create project"

## Step 2: Set up Realtime Database

1. In the Firebase Console, go to **Build > Realtime Database**
2. Click "Create Database"
3. Choose location (pick closest to your event location)
4. Start in **test mode** for now (we'll add security rules later)
5. Click "Enable"

## Step 3: Get Your Firebase Configuration

1. In Firebase Console, go to **Project Settings** (gear icon)
2. Scroll down to "Your apps"
3. Click the **Web** icon (`</>`)
4. Register your app (name: "CrowdPlay Web")
5. Copy the `firebaseConfig` object

It will look like this:

```javascript
const firebaseConfig = {
  apiKey: "AIzaSyXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
  authDomain: "crowdplay-xxxxx.firebaseapp.com",
  databaseURL: "https://crowdplay-xxxxx-default-rtdb.firebaseio.com",
  projectId: "crowdplay-xxxxx",
  storageBucket: "crowdplay-xxxxx.appspot.com",
  messagingSenderId: "123456789012",
  appId: "1:123456789012:web:xxxxxxxxxxxxxx"
};
```

## Step 4: Add Config to Your App

1. Open `app.js`
2. Find the `firebaseConfig` object at the top (lines 10-18)
3. Replace the placeholder values with your actual Firebase config

**⚠️ IMPORTANT:** Make sure the `databaseURL` ends with `.firebaseio.com` (NOT `.firebasedatabase.app`).

The correct format is:
```
https://your-project-name-default-rtdb.firebaseio.com
```

If you see connection errors in the browser console, double-check this URL!

## Step 5: Security Rules (Important!)

By default, test mode allows anyone to read/write your database for 30 days. Before your event, update the rules:

1. In Firebase Console, go to **Realtime Database > Rules**
2. Replace the rules with:

```json
{
  "rules": {
    "rooms": {
      "$roomId": {
        ".read": true,
        ".write": true,
        "toClients": {
          ".indexOn": ["timestamp"]
        }
      }
    }
  }
}
```

**Note:** These rules allow anyone to read/write. For a one-time event with a random room ID, this is acceptable. For production, implement proper authentication.

**Important:** The `.indexOn` rule is required for the participant backlog filtering to work efficiently.

## Step 6: Set Budget Alerts (Recommended)

1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Select your Firebase project
3. Go to **Billing > Budgets & alerts**
4. Create a budget with $20 limit
5. Set alert at 50%, 90%, 100%

## Step 7: Upgrade to Blaze Plan (If Needed)

The free Spark plan limits you to 100 simultaneous connections. For 300+ participants:

1. Go to Firebase Console
2. Click "Upgrade" in the bottom left
3. Select **Blaze (Pay as you go)**
4. Add billing information
5. Set budget alerts (see Step 6)

**Cost estimate:** For a 2-hour event with 300 participants, expect ~$2-5 total.

## Step 8: Test Your Setup

1. Deploy your site to GitHub Pages
2. Open `?conduct` in one browser tab
3. Open `?room=XXXXXX` (with the room ID from conductor) in another tab
4. Press B or W on the conductor tab
5. Participant tab should change color

## Troubleshooting

### "Firebase not configured" in console
- Make sure you replaced ALL placeholder values in `firebaseConfig`
- Check that `databaseURL` is set correctly

### "Permission denied" errors
- Check your Security Rules in Firebase Console
- Make sure test mode is enabled OR rules allow read/write

### Participants not connecting
- Verify the database URL includes `-default-rtdb`
- Check browser console for errors
- Make sure you're on Blaze plan if you have 100+ connections

### QR code not appearing
- Open browser console and check for errors
- Make sure the QRCode library is loading from CDN

## After Your Event

1. Go to Firebase Console > Realtime Database
2. Delete all data under `rooms/`
3. (Optional) Downgrade from Blaze to Spark plan if no longer needed

## Need Help?

- [Firebase Documentation](https://firebase.google.com/docs/database)
- [Firebase Pricing](https://firebase.google.com/pricing)
