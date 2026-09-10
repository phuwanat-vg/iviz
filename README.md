# iViz

Lightweight ROS 2 visualization for Windows. iViz connects to
[`foxglove_bridge`](https://github.com/foxglove/ros-foxglove-bridge) running on
the robot (Raspberry Pi 5) over a single WebSocket, so nothing ROS-related has
to be installed on the Windows side and no remote desktop is needed.

Built with Tauri 2 (WebView2) + TypeScript + three.js.

## Download

Grab the latest `iViz_*_x64-setup.exe` from
[Releases](https://github.com/phuwanat-vg/iviz/releases). Installed copies check
for new versions themselves, so this is a one-time download.

## Features

- 3D and 2D (top-down) views, ROS coordinate convention (x forward, y left, z up)
- Point clouds: `sensor_msgs/PointCloud2` and `livox_ros_driver2/CustomMsg`
  - color by intensity / height / RGB / flat, turbo / viridis / rainbow / gray colormaps
  - **accumulate frames** into a persistent map in the fixed frame (for FAST-LIO2 `/cloud_registered`)
  - decimation and point caps to keep WiFi and GPU load in check
- `sensor_msgs/LaserScan`, `nav_msgs/OccupancyGrid` (map & costmap palettes), `nav_msgs/Path`,
  `nav_msgs/Odometry`, `geometry_msgs/PoseStamped`, `geometry_msgs/PoseWithCovarianceStamped`,
  `geometry_msgs/PolygonStamped`
- TF tree display with frame names, selectable fixed frame, follow-frame camera
- Nav2 tools: **2D Nav Goal** (`/goal_pose`) and **2D Pose Estimate** (`/initialpose`) by click-and-drag
- Per-topic Hz and total bandwidth readout; settings persist between runs
- Auto-reconnect
- **Route mode**: draw the lanes the robot may drive and say what happens at
  each stop, over the same connection ([below](#route-mode))

## Robot side (Raspberry Pi)

```bash
sudo apt install ros-$ROS_DISTRO-foxglove-bridge
ros2 launch foxglove_bridge foxglove_bridge_launch.xml port:=8765
```

Add it to your Nav2 / FAST-LIO2 bring-up launch file so it starts with the robot.
No RViz2, no VNC.

If a point cloud is too heavy for WiFi, throttle it on the Pi with `topic_tools`
and subscribe to the throttled topic in iViz:

```bash
sudo apt install ros-$ROS_DISTRO-topic-tools
ros2 run topic_tools throttle messages /cloud_registered 2.0 /iviz/cloud_registered
```

Custom messages such as `livox_ros_driver2/msg/CustomMsg` work as long as the
package is sourced in the shell that launches `foxglove_bridge` (the bridge ships
the message definition to iViz at runtime).

## Windows side

Requirements: Node.js 22+, Rust (for the desktop build), WebView2 (included in Windows 11).

```bash
npm install
```

Run in the browser (fast iteration):

```bash
npm run dev
```

Run as a desktop window:

```bash
npm run tauri dev
```

Build the installer (`src-tauri/target/release/bundle/nsis/iViz_*.exe`):

```bash
npm run tauri build
```

Then enter `ws://<pi-ip>:8765` in the top bar and press **Connect**.

## Develop without a robot

A mock `foxglove_bridge` simulates a robot driving around a room and publishes
TF, odometry, laser scan, a FAST-LIO2 style registered point cloud, a Livox
`CustomMsg` cloud, a static map, a rolling local costmap, a plan, a footprint
and an AMCL pose. It also logs any goal / initial pose iViz publishes.

```bash
npm run mock
```

Connect iViz to `ws://localhost:8765`.

### Route mode without a robot

The mock bridge also stands in for `mission_runner`'s ROS node, so Route mode
can be developed without ROS. It advertises `/mission/api`
(`mission_msgs/srv/Api`) exactly as the robot does and forwards every call to a
runner's HTTP API, and republishes that runner's event stream on
`/mission/state` and `/mission/event`.

Start a simulated runner (it needs no ROS), then the bridge:

```bash
mission_runner run --sim --home ~/.mission-dev --port 8080
MISSION_RUNNER_URL=http://127.0.0.1:8080 npm run mock
```

`MISSION_RUNNER_URL` defaults to `http://127.0.0.1:8080`. When no runner is
listening, iViz simply reports Route mode as unavailable and keeps working as a
viewer.

## Route mode

**Route** in the top bar swaps the layer sidebar for the route editor and turns
the 3D view into an editing surface. Two things live on the map, and they are
different on purpose:

- **The route graph** belongs to the *map*, not to a mission: the points and
  lanes the robot is allowed to use, shared by every mission. Points are sites
  in `sites.json`, lanes are that map's `edges`.
- **A mission** is an ordered list of **stops**. A stop is a point on the graph
  plus the actions to perform on arrival. It is saved as ordinary `mission/1`
  JSON: each stop compiles to a `nav.follow_route` step followed by its action
  steps, so triggers, interrupts, retries and the Python export keep working.

They are two documents on the robot, but one button here: **Save to the robot**
sends whatever is unsaved and says which — *Save mission*, *Save map* or *Save
both* — with a sentence above it naming what has not been sent yet. (This
replaces the old separate *Save map data* and *Deploy* buttons.)

Because every drive is `nav.follow_route`, the robot only travels on the lanes
that were drawn.

### The panel

The panel is ordered the way the job is done: what is running, the stops, the
selected thing, saving. A section with nothing in it is not drawn — in its
place comes a card saying what to do next. On an empty map that card is the
three numbered steps (draw the points, connect them, put them in order), each
with its key and a button that arms the tool; with points but no mission it
offers the mission list; with a mission but no stops it offers the
pick-a-point-on-the-map button.

The header shows the mission's title, one sentence about what the robot is
doing, and **Run** as the prominent button with Pause and Stop beside it;
which mission, which map, what the view draws and *Reload from the robot* live
behind the small menu next to the title. Each stop is a card with its number,
its destination and its actions indented underneath. Errors are sentences, not
status codes: the technical text is folded away behind **Details**.

### Tools

The tool bar at the bottom of the view gives each tool an icon, a word and its
key on a comfortable button, fills in the armed one, and explains it in one
muted line underneath — including, while Link is dragging, what it is about to
connect ("Home ↔ Conveyor1 — let go to draw it"). Points and lanes are easier
to hit (an 18-pixel picking tolerance, a pointer cursor on hover) and what is
selected is unmistakable.

| Key | Tool | Behaviour |
|---|---|---|
| `V` | Select | Click a point, lane or stop to select. Drag a point to move it, drag its heading arrow to turn it. `Del` deletes the selection, with a confirmation when something references it. |
| `N` | Point | Click the floor to drop a point, drag before releasing to set its heading, then type its name inline. A point dropped on a lane splits that lane in two. |
| `L` | Link | Drag from one point to another to draw a lane. Hold Shift for a one-way lane. Clicking a lane selects it. |

`Esc` returns to Select, `Ctrl+Z` / `Ctrl+Y` undo and redo, and one drag is one
undo step. A route tool only takes the left mouse button, so middle-drag pan
and right-drag orbit keep working: editing works in 3D as well as in the 2D
top-down view Route mode starts in.

### What the robot needs

Route mode talks to `mission_runner` over the connection iViz already has — no
second connection, no HTTP from Windows:

- `mission_runner` running on the robot (a systemd service), and the
  `mission_msgs` package built, so it can advertise the ROS service
  `/mission/api` (`mission_msgs/srv/Api`) and publish `/mission/state` and
  `/mission/event`;
- `foxglove_bridge` launched with services enabled (the default), so that
  service reaches iViz.

When the bridge does not advertise the `services` capability, or `/mission/api`
is absent, Route mode is disabled with that reason and iViz stays a viewer.

**The robot does not need iViz.** `mission_runner` starts at boot, arms its
triggers and runs missions headless whether or not anybody is connected;
iViz is one optional window onto it.

### Not built yet

Zone drawing, route preview (`POST /api/preview/route`), the dry-run animation
and the live costmap/scan layers are deliberately left out of this version.

## Typical setups

| Stack | Fixed frame | Layers to enable |
|---|---|---|
| Nav2 + AMCL | `map` | `/map`, `/global_costmap/costmap`, `/local_costmap/costmap`, `/scan`, `/plan`, `/local_plan`, `/amcl_pose`, `/local_costmap/published_footprint` |
| FAST-LIO2 + Livox | `camera_init` | `/cloud_registered` (accumulate: all, color: z), `/Odometry` (trail on), `/path`; optionally `/livox/lidar` |

## Releases and in-app updates

Installed copies of iViz check GitHub Releases for a newer version a few
seconds after launch (and on **About → Check for updates**). When one exists the
user gets an "Install & restart" prompt; the installer is downloaded, its
minisign signature is verified against the public key embedded in the app, and
iViz restarts on the new version.

One-time setup (done for `phuwanat-vg/iviz`, repeat it for a fork):

1. Push the repository to GitHub and point
   `src-tauri/tauri.conf.json` → `plugins.updater.endpoints` at it.
2. The signing keypair was generated at `%USERPROFILE%\.tauri\iviz.key` (private)
   and `iviz.key.pub` (public, already in `tauri.conf.json`). Back the private key
   up somewhere safe. If it is lost, existing installs can never update again.
   Never commit it.
3. In the GitHub repo add two Actions secrets:
   - `TAURI_SIGNING_PRIVATE_KEY` = the full contents of `iviz.key`
   - `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` = the key password (it was created with an empty password, so set an empty value)

Publishing a release:

```bash
npm run version:set 0.2.0
```

```bash
git commit -am "release v0.2.0" && git tag v0.2.0 && git push && git push --tags
```

The `release` workflow (`.github/workflows/release.yml`) builds the Windows
installer, signs it, creates the GitHub Release with the `.exe`, `.msi`, `.sig`
files and `latest.json`. Running apps pick the new version up automatically.
Add release notes to `CHANGELOG.md` before tagging.

To host updates yourself instead of GitHub, put `latest.json` and the artifacts
on any HTTPS server and list that URL under `plugins.updater.endpoints`. The
format is:

```json
{
  "version": "0.2.0",
  "notes": "What changed",
  "pub_date": "2026-09-02T12:00:00Z",
  "platforms": {
    "windows-x86_64": {
      "signature": "<contents of iViz_0.2.0_x64-setup.exe.sig>",
      "url": "https://example.com/iviz/iViz_0.2.0_x64-setup.exe"
    }
  }
}
```

Local signed build (same thing CI does). Use **bash**, not PowerShell:

```bash
export TAURI_SIGNING_PRIVATE_KEY="$(cat "$USERPROFILE/.tauri/iviz.key")"
export TAURI_SIGNING_PRIVATE_KEY_PASSWORD=""
npm run tauri build
```

PowerShell deletes an environment variable when you assign it an empty string,
so the password never reaches the CLI and the build stops forever on
`Decrypting updater signing key, expect a prompt for password`. A successful
build ends with `Finished 2 updater signatures at:`.

This produces `iViz_<version>_x64-setup.exe` plus a `.sig` file next to it; the
`.sig` contents go into the `signature` field of `latest.json`.

## Project layout

```
src/
  net/FoxgloveConnection.ts   WebSocket client, subscriptions, service calls, CDR decoding, stats
  ros/                        message schemas, types, TF tree, decoder cache
  viz/Viewer.ts               three.js scene, cameras, controls, pose and editing tools
  viz/layers/                 one renderer per message type, plus RouteLayer
  ui/App.ts                   top bar, sidebar, layer settings
  ui/RoutePanel.ts            Route mode sidebar; RouteTools.ts the editing tools
  ui/ActionForm.ts            the action picker and the forms behind it
  mission/                    mission model, validation and the /mission/api client
  state/settings.ts           localStorage persistence
tools/mock-server.ts          fake foxglove_bridge for development
src-tauri/                    Tauri desktop shell
```
