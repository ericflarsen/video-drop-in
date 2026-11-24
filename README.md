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
   a device on the home network to check that it's running. For calls, use the
   public Tailscale Funnel address: browsers only allow the camera and
   microphone over HTTPS.

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


## Call alerts on Mom's phone

When someone starts a call, Mom's phone rings with a notification, even if the
Mom's Call app is closed. Tapping it opens the app on the Answer screen.

- **iPhone:** alerts only work from the Home Screen app. Open Mom's link in
  Safari, tap Share, then **Add to Home Screen**, and open Mom's Call from the
  Home Screen. Needs iOS 16.4 or later.
- **Android:** works from Chrome, installed or not.
- Then tap **Ring my phone when family calls** once and allow notifications.

Only Mom's own sign-in (her link) can turn alerts on; a family member testing
the Mom page doesn't see the button. Only starting a call rings Mom; joining a
call already in progress does not.
Alerts expire after a minute, so a phone that was offline won't ring late.
While Mom's Call is open and no one is calling, the page checks for a call
every 5 seconds, and right away when an alert arrives. It checks quickly only
while a call is ringing or connecting, and not at all while hidden (unless she
is on a call). The
app keeps its push signing key and Mom's devices in its private data folder,
and drops a device automatically when its browser unsubscribes. No call content
goes through the push service: only the caller's name.

## Access

- **Family passphrase.** Set it in the app configuration. Family members open
  the public page, enter their name and the passphrase once, and the device
  stays signed in for a year. The sign-in cookie is signed with a secret kept in
  the app's private data folder, so it cannot be forged. Changing the
  passphrase signs every device out.
- **Mom's link.** A private link that signs Mom's phone in. To get it for a new
  phone, open `/api/mom-link` on the public page while signed in as family; it
  returns the path to add after the page address. Opening it once signs Mom's
  phone in and removes the key from the address, so the home-screen app keeps
  working. If the app ever shows "This link isn't working", paste the link into
  the box on that screen. Mom's link can only answer;
  it cannot wake the TV or start a call. It is separate from the passphrase, so
  changing the passphrase does not affect it.
- **Attempt limits.** Wrong passphrases and bad Mom links answer more slowly
  each time. After 10 in an hour, new sign-ins are refused for an hour and Home
  Assistant shows a notification. Devices already signed in are not affected.
  If the Funnel relay passes the visitor's address (`X-Forwarded-For`), a
  per-visitor limit of 5 also applies; the log says when it does.
- **Quiet hours and wake limit.** Between `quiet_start` and `quiet_end`
  (default 22:00 to 08:00) the caller must confirm before the TV wakes, and Home
  Assistant shows a notification when someone does. The TV can be woken at most
  `max_wakes_per_hour` times an hour (default 3).

## Calling Mom

Choose **Call Mom on the TV**. Mom's page
shows who is calling. She can turn on her camera to see herself, turn on her
microphone, then tap **Answer**. If she refreshes her page, she can tap Answer
again to rejoin.

If Mom has the page open on more than one device, all of them show the call.
Answering on one takes the call; answering on another moves it there.

## Several callers

Up to 4 family members can be on a call. The first caller wakes the TV; anyone
else who opens the family page sees **Join the call**, which never wakes the TV
again or counts toward the wake limit. A 5th caller sees that the call is full.

- **TV:** 1 to 3 callers side by side, 4 as a 2×2 grid, each with a name. A
  soft chime and a "Sarah joined" banner mark each new caller.
- **Family page:** each caller sees and hears Mom and every other caller. Mom's
  tile is largest while her camera is on.
- **Mom:** hears everyone through the TV; her camera and microphone go to every
  caller, including people who join after she answers.
- The call ends for the TV and Mom when the last caller hangs up. A caller page
  that stops responding for 45 seconds is removed.

Media never passes through the Home Assistant host. Every page connects directly
to every other page (a mesh); the host only introduces them. Each caller uploads
one copy of their video per other page, so videos are scaled down as the call
grows (about 720p alone, 480p with 2 or 3 callers, 360p with 4).

WebRTC uses a public STUN server to help browsers find a direct path. TURN relay
is not configured, so some restrictive networks may still block calls. Echo from
TV audio being picked up by Mom's separate phone is an open issue and needs a
real-world check.

## Later consideration

Investigate whether the Fire TV can return to its pre-call state after hang-up,
including restoring its previous app or returning to off if it started off.
