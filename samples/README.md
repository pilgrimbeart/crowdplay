# Audio Samples Directory

Place your audio files here for use in CrowdPlay.

## Manifest File

**Important**: After adding audio files, you must update `manifest.json`:

```json
{
  "files": [
    "samples/loop.mp3",
    "samples/clap.mp3",
    "samples/your-new-file.mp3"
  ],
  "version": "1.0"
}
```

All files listed in the manifest are preloaded when participants join, ensuring zero-latency synchronized playback.

## Supported Formats

**Use MP3 format** for maximum browser compatibility (works on all browsers including iOS Safari).

- **MP3**: ✅ Universal support
- **OGG/Vorbis**: ⚠️ Not supported on iOS Safari
- **WAV**: ✅ Supported but very large file sizes

## Recommended Sample Properties

For looping audio:
- **Duration**: 2-8 seconds (short loops are easier to sync-test)
- **Seamless loop**: Audio should loop without clicks/gaps
- **File size**: <1MB (will be downloaded by 300+ clients)
- **Bitrate**: 128kbps is sufficient

## Where to Find Samples

### Free Looping Samples (CC0 / Public Domain):

1. **Freesound.org**
   - Search: "loop" + filter by CC0 license
   - Good for: Music loops, sound effects

2. **OpenGameArt.org**
   - Category: Music
   - Many seamless game music loops

3. **BBC Sound Effects**
   - https://sound-effects.bbcrewind.co.uk/
   - Free for education/testing

4. **Incompetech.com**
   - Kevin MacLeod's royalty-free music
   - CC BY license (credit required)

### Quick Test Samples:

**Simple metronome/beep** (for testing sync):
- Short (0.5-1s) click or beep
- Easy to tell if clients are in sync

**Handclap loop** (for rhythm testing):
- 120 BPM, 4-beat loop
- Classic 808 handclaps work well

## Default File

The conductor's 'P' key currently triggers: `samples/loop.mp3`

Add your `loop.mp3` file here, or edit `app.js` line ~282 to change the default file.

## Testing Your Sample

1. Add your MP3 file to this directory (e.g., `loop.mp3`)
2. Make sure it's committed to git
3. Push to GitHub
4. Wait for GitHub Pages to deploy (~1-2 min)
5. Press 'P' in conductor mode to test

## File Naming

Use descriptive names:
- `metronome-120bpm.mp3`
- `handclap-loop.mp3`
- `ambient-drone.mp3`

Avoid spaces in filenames (use hyphens or underscores).
