# Video Drop In

A Home Assistant app for family video calls, with a mobile answer page and an
optional Fire TV receiver.

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

Tailscale Funnel provides the public HTTPS page without router port forwarding. The app does not relay or record call media.

## Camera and microphone

Browsers require HTTPS or localhost to request camera and microphone access.
For phone and remote use, open the public Tailscale Funnel URL. The caller page
is at the root; Mom's mobile answer page is at /mom.

The TV receiver is opened at http://localhost:8765 through ADB reverse port
mapping, so the TV can treat it as a local origin.

## Dependencies

The app image installs android-tools-adb with Alpine's package manager.
Signaling uses Python's standard library; the browser provides WebRTC.


## Calling Mom

Open the caller page and choose Text Mom a call link to open the device's sharing
menu. Select Messages to text her the link, then choose Start a call with Mom.
The share button prepares the message but does not send it automatically.

Mom's page asks for camera and microphone access only when she answers. Large
buttons let her turn the camera or microphone off or back on during a call, and
she can hang up at any time. The link is the public HTTPS address followed by
/mom.

WebRTC media is sent directly between browsers. STUN/TURN relay configuration
is still outstanding, so calls between some networks may not connect yet.

## Later consideration

Investigate whether the Fire TV can return to its pre-call state after hang-up,
including restoring its previous app or returning to off if it started off.
