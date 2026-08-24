# Sharing a trip

The app keeps your trip in one browser and nowhere else. Sharing it with the
people you are travelling with needs somewhere both of you can reach, and this
page sets that up with a Google account and no server of your own.

It takes about five minutes and you only do it once.

## What you are building

`tools/sync.gs` is a Google Apps Script web app. Google hosts and runs it for
free. It keeps one JSON file per trip in your Drive, and the app pushes and
pulls the whole trip through it.

## Setting it up

1. Go to <https://script.google.com> and start a **New project**.
2. Delete the sample `myFunction` and paste in the whole of `tools/sync.gs`.
3. Save, then **Deploy → New deployment**.
4. Choose type **Web app**, and set:
   - **Execute as** — *Me*
   - **Who has access** — *Anyone*
5. Deploy. Google will ask you to authorise it; it wants Drive access because
   that is where it puts the file.
6. Copy the **Web app URL**. It ends in `/exec`.
7. In the app: **About → Sharing**, paste the URL, and pick a trip code.

Give the URL and the code to whoever you are travelling with. They paste the
same two things and press **Get the shared copy**.

*Anyone* sounds alarming and is not optional: your travelling companions are
not signing in to your Google account, so the script has to be reachable
without one. What it will actually do is read and write one folder it created,
and only for a code somebody already knows.

## What this is, honestly

The URL and the trip code together **are** the password. There is no login.
Anyone who has both can read the trip — flight times, hotel address,
confirmation numbers — and can overwrite it.

So:

- Send them the way you would send the booking confirmation itself.
- The URL is not in this repository, and should not be. It lives in your
  browser's own settings and is typed in per device.
- Use a code that is not guessable. `fukuoka` is a bad code. The app offers a
  random one and you should take it.
- When the trip is over, delete the file from the **TravelApp trips** folder in
  your Drive.

## How a sync decides

Every edit bumps a revision number. The app remembers which revision last went
over the wire, so it can tell three cases apart:

| | |
|---|---|
| only you have edited | it pushes |
| only they have edited | it pulls |
| both have | it asks, and you choose |

The whole trip travels as one document, so there is no merging: if both sides
have moved, one of them is going to lose. The app will not decide that quietly.
The script refuses a save built on an older copy for the same reason, so a
stale phone in someone's pocket cannot overwrite the day you just planned.

In practice, sync before you start editing and again when you stop.

## If something goes wrong

- **"the sync service returned 401"** or a login page — the deployment is not
  set to *Anyone*. Redeploy with that access.
- **Nothing happens and the console shows a CORS error** — you pasted the
  `/dev` URL. It has to be the `/exec` one from a deployment.
- **Changes are not arriving** — check both devices are on the same trip code.
- **You want to start over** — delete `trip-<code>.json` from the Drive folder.

## Changing the script later

Apps Script keeps the old code live until you deploy again. **Deploy → Manage
deployments → edit → Version: New version** updates the same `/exec` URL, so
nobody has to be given a new one.
