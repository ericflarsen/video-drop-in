# Video Drop In

A Home Assistant app that wakes a Fire TV and opens a Silk receiver for a
local WebRTC call.

## Install from Home Assistant

1. In Home Assistant, open **Settings → Apps**.
2. Open the menu in the upper-right, choose **Repositories**, and add
   https://github.com/ericflarsen/video-drop-in
3. Install **Video Drop In** from the app store.
4. In the app configuration, enter the Fire TV ADB address, such as
   192.168.1.x:5555.
5. Start the app and open the Home Assistant local address on port 8765 from
   a device on the home network.

The TV must authorize this app's ADB key once. If the first call reports that
the device is unauthorized, wake the TV with its remote, accept the ADB
authorization prompt, select “Always allow” if offered, then retry.

The app installs ADB inside its own container. It does not install packages on
Home Assistant OS.

No router port forwarding, tunnel, media relay, or paid service is used.

## Camera and microphone

The local HTTP page can test the wake-and-open-TV path. Browsers only expose
camera and microphone capture on secure origins such as HTTPS or localhost.
Because a phone opening the Home Assistant LAN address is not localhost, full
calling from a phone needs trusted HTTPS. This app intentionally does not
create a self-signed certificate or bypass browser security.

The TV receiver page is opened at http://localhost:8765 through ADB reverse
port mapping, so the TV can treat it as a local origin.

## Dependencies

The app image installs android-tools-adb with Alpine's package manager.
Signaling uses Python's standard library; the browser provides WebRTC.
